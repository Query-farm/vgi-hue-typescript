#!/usr/bin/env python3
"""A dependency-free, stateful mock of a Philips Hue bridge's CLIP v2 API.

The worker's tests run against this server so they stay deterministic and
offline. PUTs change the in-memory state, so a test can change a light and
read the result back with ``lights()``.

Home layout
-----------
* Kitchen:     "Kitchen ceiling" (white ambiance, on), "Kitchen pendant"
               (dimmable white only, on), "Kitchen sensor" (motion sensor)
* Living room: "Sofa lamp" (colour, off), "Desk lamp" (colour, on, unreachable),
               "Living room sensor" (motion sensor, disabled: its readings are
               stale, as a real bridge keeps them), "Hue tap dial switch"
               (battery only; its buttons are not read)
* Hallway:     "Hallway sensor" (motion sensor), "Front door" (contact sensor)
* Zone "Downstairs": Kitchen ceiling + Sofa lamp
* Scenes: Relax (Kitchen), Bright (Kitchen), Relax (Living room)

Endpoints: ``GET /clip/v2/resource/<type>``, ``PUT /clip/v2/resource/<type>/<id>``
for light, grouped_light and scene, ``GET /health``, and for discovery tests:
``GET /api/config`` (unauthenticated bridge identity, like a real bridge) and
``GET /discovery`` (a stand-in for https://discovery.meethue.com listing this
mock; ``/discovery/none`` lists nothing).

Switches (environment):
* ``MOCK_APP_KEY`` (default ``test-key``): required ``hue-application-key``.
* ``MOCK_FLAKY=1``: the first GET of every path answers 429 + Retry-After: 0.
* ``MOCK_GROUP_DELAY_MS``: apply grouped_light commands to the bulbs only after
  this delay, as a real bridge relays them over Zigbee one bulb at a time.

Usage: ``python3 test/mock_bridge/server.py`` prints ``PORT:<n>`` once listening.
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_KEY = os.environ.get("MOCK_APP_KEY", "test-key")
BRIDGE_ID = "001788FFFE00BEEF"


def ref(rid: str, rtype: str) -> dict:
    return {"rid": rid, "rtype": rtype}


def device(did: str, name: str, model: str, product: str, services: list[dict]) -> dict:
    return {
        "id": did,
        "type": "device",
        "metadata": {"name": name, "archetype": "classic_bulb"},
        "product_data": {"model_id": model, "product_name": product, "manufacturer_name": "Signify"},
        "services": services,
    }


def light(lid: str, did: str, name: str, on: bool, bri: float, mirek: int | None, xy: tuple | None, archetype: str) -> dict:
    out: dict = {
        "id": lid,
        "type": "light",
        "owner": ref(did, "device"),
        "metadata": {"name": name, "archetype": archetype},
        "on": {"on": on},
        "dimming": {"brightness": bri},
    }
    if mirek is not None or xy is not None:
        out["color_temperature"] = {"mirek": mirek, "mirek_valid": mirek is not None}
    if xy is not None:
        out["color"] = {"xy": {"x": xy[0], "y": xy[1]}}
    return out


def sensor_services(
    did: str, prefix: str, motion: bool, temp: float, level: int, battery: int, state: str, changed: str, enabled: bool = True
) -> list[dict]:
    return [
        {"id": f"{prefix}-motion", "type": "motion", "owner": ref(did, "device"), "enabled": enabled,
         "motion": {"motion": motion, "motion_valid": True, "motion_report": {"changed": changed, "motion": motion}}},
        {"id": f"{prefix}-temp", "type": "temperature", "owner": ref(did, "device"), "enabled": enabled,
         "temperature": {"temperature": temp, "temperature_valid": True,
                         "temperature_report": {"changed": changed, "temperature": temp}}},
        {"id": f"{prefix}-light", "type": "light_level", "owner": ref(did, "device"), "enabled": enabled,
         "light": {"light_level": level, "light_level_valid": True,
                   "light_level_report": {"changed": changed, "light_level": level}}},
        {"id": f"{prefix}-power", "type": "device_power", "owner": ref(did, "device"),
         "power_state": {"battery_state": state, "battery_level": battery}},
    ]


def initial_state() -> dict[str, list[dict]]:
    devices = [
        device("d-ceiling", "Kitchen ceiling", "LTW001", "Hue white ambiance lamp", [ref("l-ceiling", "light")]),
        device("d-pendant", "Kitchen pendant", "LWB010", "Hue white lamp", [ref("l-pendant", "light")]),
        device("d-sofa", "Sofa lamp", "LCA001", "Hue color lamp", [ref("l-sofa", "light")]),
        device("d-desk", "Desk lamp", "LCA001", "Hue color lamp", [ref("l-desk", "light")]),
        device("d-ksensor", "Kitchen sensor", "SML001", "Hue motion sensor", []),
        device("d-hsensor", "Hallway sensor", "SML001", "Hue motion sensor", []),
        device("d-door", "Front door", "SOC001", "Hue secure contact sensor", []),
        device("d-lsensor", "Living room sensor", "SML001", "Hue motion sensor", []),
        device("d-dial", "Hue tap dial switch", "RDM002", "Hue tap dial switch", [ref("dial-button-1", "button")]),
    ]
    lights = [
        light("l-ceiling", "d-ceiling", "Kitchen ceiling", True, 80.0, 370, None, "ceiling_round"),
        light("l-pendant", "d-pendant", "Kitchen pendant", True, 50.0, None, None, "pendant_round"),
        light("l-sofa", "d-sofa", "Sofa lamp", False, 30.0, None, (0.5, 0.4), "floor_shade"),
        light("l-desk", "d-desk", "Desk lamp", True, 100.0, 250, (0.4, 0.38), "table_shade"),
    ]
    # The ceiling light is white ambiance: colour temperature but no xy colour.
    lights[0].pop("color", None)
    rooms = [
        {"id": "r-kitchen", "type": "room", "metadata": {"name": "Kitchen", "archetype": "kitchen"},
         "children": [ref("d-ceiling", "device"), ref("d-pendant", "device"), ref("d-ksensor", "device")],
         "services": [ref("gl-kitchen", "grouped_light")]},
        {"id": "r-living", "type": "room", "metadata": {"name": "Living room", "archetype": "living_room"},
         "children": [ref("d-sofa", "device"), ref("d-desk", "device"), ref("d-lsensor", "device"), ref("d-dial", "device")],
         "services": [ref("gl-living", "grouped_light")]},
        {"id": "r-hallway", "type": "room", "metadata": {"name": "Hallway", "archetype": "hallway"},
         "children": [ref("d-hsensor", "device"), ref("d-door", "device")],
         "services": [ref("gl-hallway", "grouped_light")]},
    ]
    zones = [
        {"id": "z-downstairs", "type": "zone", "metadata": {"name": "Downstairs", "archetype": "downstairs"},
         "children": [ref("l-ceiling", "light"), ref("l-sofa", "light")],
         "services": [ref("gl-downstairs", "grouped_light")]},
    ]
    scenes = [
        {"id": "s-relax-kitchen", "type": "scene", "metadata": {"name": "Relax"}, "group": ref("r-kitchen", "room"),
         "status": {"active": "inactive"},
         "actions": [{"target": ref("l-ceiling", "light"), "action": {"on": {"on": True}, "dimming": {"brightness": 40.0}, "color_temperature": {"mirek": 447}}},
                     {"target": ref("l-pendant", "light"), "action": {"on": {"on": False}}}]},
        {"id": "s-bright-kitchen", "type": "scene", "metadata": {"name": "Bright"}, "group": ref("r-kitchen", "room"),
         "status": {"active": "static"},
         "actions": [{"target": ref("l-ceiling", "light"), "action": {"on": {"on": True}, "dimming": {"brightness": 100.0}}}]},
        {"id": "s-relax-living", "type": "scene", "metadata": {"name": "Relax"}, "group": ref("r-living", "room"),
         "status": {"active": "inactive"},
         "actions": [{"target": ref("l-sofa", "light"), "action": {"on": {"on": True}, "dimming": {"brightness": 35.0}, "color_temperature": {"mirek": 447}}}]},
    ]
    sensors = (
        sensor_services("d-ksensor", "ks", False, 23.25, 1, 80, "normal", "2026-11-01T08:30:00.000Z")
        + sensor_services("d-hsensor", "hs", True, 19.5, 20001, 15, "low", "2026-11-01T10:00:00.000Z")
        # Disabled: a real bridge keeps the last (stale) values, here hot, bright and moving.
        + sensor_services("d-lsensor", "ls", True, 30.0, 30001, 100, "normal", "2026-10-01T12:00:00.000Z", enabled=False)
    )
    dial = [
        {"id": "dial-power", "type": "device_power", "owner": ref("d-dial", "device"),
         "power_state": {"battery_state": "normal", "battery_level": 74}},
    ]
    contact = [
        {"id": "door-contact", "type": "contact", "owner": ref("d-door", "device"), "enabled": True,
         "contact_report": {"changed": "2026-11-01T09:15:00.000Z", "state": "no_contact"}},
        {"id": "door-power", "type": "device_power", "owner": ref("d-door", "device"),
         "power_state": {"battery_state": "normal", "battery_level": 90}},
    ]
    zigbee = [
        {"id": f"zb-{d['id']}", "type": "zigbee_connectivity", "owner": ref(d["id"], "device"),
         "status": "connectivity_issue" if d["id"] == "d-desk" else "connected"}
        for d in devices
    ]
    by_type: dict[str, list[dict]] = {
        "device": devices, "light": lights, "room": rooms, "zone": zones, "scene": scenes,
        "zigbee_connectivity": zigbee, "contact": [c for c in contact if c["type"] == "contact"],
    }
    for s in sensors + contact + dial:
        if s["type"] != "contact":
            by_type.setdefault(s["type"], []).append(s)
    return by_type


STATE = initial_state()
LOCK = threading.RLock()  # re-entrant: delayed group commands take it too
_flaky_seen: set[str] = set()


def find(rtype: str, rid: str) -> dict | None:
    return next((r for r in STATE.get(rtype, []) if r["id"] == rid), None)


def group_lights(group: dict) -> list[dict]:
    devices = {c["rid"] for c in group["children"] if c["rtype"] == "device"}
    ids = {c["rid"] for c in group["children"] if c["rtype"] == "light"}
    return [l for l in STATE["light"] if l["id"] in ids or l["owner"]["rid"] in devices]


def grouped_lights() -> list[dict]:
    out = []
    for g in STATE["room"] + STATE["zone"]:
        members = group_lights(g)
        lit = [l for l in members if l["on"]["on"]]
        bri = round(sum(l["dimming"]["brightness"] for l in lit) / len(lit), 2) if lit else 0.0
        out.append({"id": g["services"][0]["rid"], "type": "grouped_light", "owner": {"rid": g["id"], "rtype": g["type"]},
                    "on": {"on": bool(lit)}, "dimming": {"brightness": bri}})
    return out


def apply_light(l: dict, body: dict) -> str | None:
    """Apply a light PUT body; return an error description or None."""
    if "color" in body and "color" not in l:
        return f"device ({l['metadata']['name']}) does not support color"
    if "color_temperature" in body and "color_temperature" not in l:
        return f"device ({l['metadata']['name']}) does not support color_temperature"
    if "on" in body:
        l["on"]["on"] = bool(body["on"]["on"])
    if "dimming" in body:
        l["dimming"]["brightness"] = float(body["dimming"]["brightness"])
    if "color_temperature" in body:
        l["color_temperature"] = {"mirek": body["color_temperature"]["mirek"], "mirek_valid": True}
    if "color" in body:
        l["color"] = {"xy": body["color"]["xy"]}
        l["color_temperature"] = {"mirek": None, "mirek_valid": False}
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        sys.stderr.write("mock_bridge: " + (format % args) + "\n")

    def _send(self, status: int, body: object, headers: dict[str, str] | None = None) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def _error(self, status: int, description: str) -> None:
        self._send(status, {"errors": [{"description": description}], "data": []})

    def _route(self) -> list[str] | None:
        if self.path == "/health":
            self._send(200, {"status": "ok"})
            return None
        if self.path == "/api/config":
            self._send(200, {"name": "Mock bridge", "bridgeid": BRIDGE_ID, "apiversion": "1.70.0"})
            return None
        if self.path in ("/discovery", "/discovery/none"):
            port = self.server.server_address[1]
            entries = [] if self.path.endswith("none") else [
                {"id": BRIDGE_ID.lower(), "internalipaddress": "127.0.0.1", "port": port}
            ]
            self._send(200, entries)
            return None
        parts = self.path.strip("/").split("/")
        if parts[:3] != ["clip", "v2", "resource"] or len(parts) < 4:
            self._error(404, "Not Found")
            return None
        if self.headers.get("hue-application-key") != APP_KEY:
            self._error(403, "unauthorized user")
            return None
        return parts[3:]

    def do_GET(self) -> None:
        parts = self._route()
        if parts is None:
            return
        if os.environ.get("MOCK_FLAKY") == "1":
            with LOCK:
                if self.path not in _flaky_seen:
                    _flaky_seen.add(self.path)
                    self._send(429, {"errors": [{"description": "rate limited"}]}, {"Retry-After": "0"})
                    return
        with LOCK:
            items = grouped_lights() if parts[0] == "grouped_light" else copy.deepcopy(STATE.get(parts[0], []))
        if len(parts) > 1:
            items = [i for i in items if i["id"] == parts[1]]
            if not items:
                self._error(404, "Not Found")
                return
        for i in items:
            i.pop("actions", None)
        self._send(200, {"errors": [], "data": items})

    def do_PUT(self) -> None:
        parts = self._route()
        if parts is None:
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._error(400, "body contains invalid JSON")
            return
        if len(parts) != 2:
            self._error(405, "method not allowed")
            return
        rtype, rid = parts
        with LOCK:
            if rtype == "light":
                target = find("light", rid)
                if target is None:
                    self._error(404, "Not Found")
                    return
                err = apply_light(target, body)
                if err:
                    self._error(400, err)
                    return
            elif rtype == "grouped_light":
                group = next((g for g in STATE["room"] + STATE["zone"] if g["services"][0]["rid"] == rid), None)
                if group is None:
                    self._error(404, "Not Found")
                    return
                def apply_group(members: list[dict] = group_lights(group), body: dict = body) -> None:
                    with LOCK:
                        for l in members:
                            # A group command skips capabilities a member lacks, as the bridge does.
                            apply_light(l, {k: v for k, v in body.items() if k not in ("color", "color_temperature") or k in l})

                delay_ms = int(os.environ.get("MOCK_GROUP_DELAY_MS") or 0)
                if delay_ms:
                    threading.Timer(delay_ms / 1000, apply_group).start()
                else:
                    apply_group()
            elif rtype == "scene":
                scene = find("scene", rid)
                if scene is None:
                    self._error(404, "Not Found")
                    return
                if body.get("recall", {}).get("action") != "active":
                    self._error(400, "unsupported scene update")
                    return
                for act in scene["actions"]:
                    target = find("light", act["target"]["rid"])
                    if target is not None:
                        apply_light(target, act["action"])
                for other in STATE["scene"]:
                    if other["group"]["rid"] == scene["group"]["rid"]:
                        other["status"]["active"] = "static" if other is scene else "inactive"
            else:
                self._error(405, f"cannot PUT {rtype}")
                return
        self._send(200, {"errors": [], "data": [{"rid": rid, "rtype": rtype}]})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"PORT:{server.server_address[1]}", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


if __name__ == "__main__":
    main()
