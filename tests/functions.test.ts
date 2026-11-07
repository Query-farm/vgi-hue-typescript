// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Arguments, batchFromColumns, bool, field, float64, int64, schema, utf8, VgiClient } from "@query-farm/vgi";
import { subprocessConnect } from "@query-farm/vgi-rpc";
import { decodeAttachOptions, encodeAttachOptions } from "../src/attach.ts";
import { lightReflects, matchByIdOrName, recallScene, setLight, setRoom } from "../src/control.ts";
import { candidateUrl, chooseBridge, discoverBridge, isBridgeId, mdnsQuery } from "../src/discovery.ts";
import {
  type BridgeConnection,
  buildStateBody,
  getResources,
  type HueLight,
  hueRequest,
  kelvinToMirek,
  lightLevelToLux,
  parseColor,
  resolveConnection,
  rgbToXy,
  xyToHex,
} from "../src/hue.ts";
import { lightRowId, lightRows, roomRows, sensorRows } from "../src/inventory.ts";
import { applyToRow, checkKnownColumns, rowChange, updateBody } from "../src/lights_write.ts";

const ROOT = join(import.meta.dir, "..");

describe("connection settings", () => {
  const noDiscovery = async (): Promise<never> => {
    throw new Error("discovery should not run");
  };

  test("ATTACH options win over the environment", async () => {
    const env = { HUE_BRIDGE: "10.0.0.9", HUE_APP_KEY: "env-key" };
    expect(await resolveConnection({ bridge: "192.168.1.20", app_key: "opt-key" }, env, noDiscovery)).toEqual({
      baseUrl: "https://192.168.1.20",
      appKey: "opt-key",
    });
    expect(await resolveConnection({}, env, noDiscovery)).toEqual({ baseUrl: "https://10.0.0.9", appKey: "env-key" });
    expect((await resolveConnection({ bridge: "http://127.0.0.1:8080/" }, env, noDiscovery)).baseUrl).toBe(
      "http://127.0.0.1:8080",
    );
  });

  test("a missing app key is an error before any discovery", async () => {
    await expect(resolveConnection({ bridge: "x" }, {}, noDiscovery)).rejects.toThrow(/No Hue app key/);
    await expect(resolveConnection({}, {}, noDiscovery)).rejects.toThrow(/No Hue app key/);
  });

  test("no bridge, or a bridge id, goes to discovery", async () => {
    const seen: (string | null)[] = [];
    const fake = async (id: string | null) => {
      seen.push(id);
      return { id: "001788fffe00beef", name: null, url: "https://192.168.1.77" };
    };
    expect((await resolveConnection({ app_key: "k" }, {}, fake)).baseUrl).toBe("https://192.168.1.77");
    expect((await resolveConnection({ app_key: "k", bridge: "001788FFFE00BEEF" }, {}, fake)).baseUrl).toBe(
      "https://192.168.1.77",
    );
    expect(seen).toEqual([null, "001788FFFE00BEEF"]);
  });

  test("attach options round-trip through attach_opaque_data", () => {
    const bytes = encodeAttachOptions({ bridge: " 1.2.3.4 ", app_key: "k", other: 5 });
    expect(decodeAttachOptions(bytes)).toEqual({ bridge: "1.2.3.4", app_key: "k" });
    expect(decodeAttachOptions(encodeAttachOptions(undefined))).toEqual({});
    expect(decodeAttachOptions(new Uint8Array([1, 2, 3]))).toEqual({});
    expect(decodeAttachOptions(null)).toEqual({});
  });
});

describe("discovery", () => {
  const bridge = (id: string, url: string) => ({ id, name: null, url });

  test("bridge ids are 16 hex digits", () => {
    expect(isBridgeId("001788fffe00BEEF")).toBe(true);
    expect(isBridgeId("192.168.1.20")).toBe(false);
  });

  test("candidate URLs omit default ports and bracket IPv6", () => {
    expect(candidateUrl({ host: "192.168.1.2", port: 443 })).toBe("https://192.168.1.2");
    expect(candidateUrl({ host: "192.168.1.2", port: 8443 })).toBe("https://192.168.1.2:8443");
    expect(candidateUrl({ host: "fe80::1" })).toBe("https://[fe80::1]");
  });

  test("choosing: one bridge, a wanted id, none, or several", () => {
    const a = bridge("aaaaaaaaaaaaaaaa", "https://10.0.0.1");
    const b = bridge("bbbbbbbbbbbbbbbb", "https://10.0.0.2");
    expect(chooseBridge([a], null)).toBe(a);
    expect(chooseBridge([a, b], "BBBBBBBBBBBBBBBB")).toBe(b);
    expect(() => chooseBridge([], null)).toThrow(/no Hue bridge found/);
    expect(() => chooseBridge([a, b], null)).toThrow(/found 2 Hue bridges/);
    expect(() => chooseBridge([a], "cccccccccccccccc")).toThrow(/no Hue bridge with id/);
  });

  test("the mDNS query asks for _hue._tcp.local PTR records", () => {
    const q = mdnsQuery();
    expect(new TextDecoder().decode(q.slice(13, 17))).toBe("_hue");
    expect([...q.slice(-4)]).toEqual([0, 12, 0, 1]);
  });

  test("mDNS results are tried first, then the cloud; unconfirmed hosts are dropped", async () => {
    const probe = async (url: string) => (url === "https://10.0.0.5" ? { id: "001788fffe000005", name: "Home" } : null);
    let cloudCalled = false;
    const found = await discoverBridge(null, {
      env: {},
      cacheFile: null,
      mdns: async () => [{ host: "10.0.0.9" }, { host: "10.0.0.5" }],
      cloud: async () => {
        cloudCalled = true;
        return [];
      },
      probe,
    });
    expect(found).toEqual({ id: "001788fffe000005", name: "Home", url: "https://10.0.0.5" });
    expect(cloudCalled).toBe(false);
  });

  test("the cloud fills in when mDNS finds nothing", async () => {
    const found = await discoverBridge(null, {
      env: { HUE_DISCOVERY_MDNS: "off" },
      cacheFile: null,
      cloud: async () => [{ host: "10.0.0.6", port: 443, id: "001788fffe000006" }],
      probe: async () => ({ id: "001788fffe000006", name: null }),
    });
    expect(found.url).toBe("https://10.0.0.6");
  });

  test("HUE_DISCOVERY=off refuses to guess", async () => {
    await expect(discoverBridge(null, { env: { HUE_DISCOVERY: "off" }, cacheFile: null })).rejects.toThrow(
      /discovery is off/,
    );
  });
});

describe("colour math", () => {
  test("kelvin to mirek clamps to the Hue range", () => {
    expect(kelvinToMirek(2700)).toBe(370);
    expect(kelvinToMirek(1000)).toBe(500);
    expect(kelvinToMirek(10000)).toBe(153);
  });

  test("colours parse from hex, short hex and names", () => {
    expect(parseColor("#FF8000")).toEqual([255, 128, 0]);
    expect(parseColor("f80")).toEqual([255, 136, 0]);
    expect(parseColor("Blue")).toEqual([0, 0, 255]);
    expect(() => parseColor("#12345")).toThrow(/invalid color/);
  });

  test("rgb -> xy -> hex keeps the primary hue", () => {
    const red = rgbToXy([255, 0, 0]);
    expect(red).toEqual({ x: 0.7006, y: 0.2993 });
    expect(xyToHex(red.x, red.y).slice(1, 3)).toBe("ff");
    expect(rgbToXy([0, 0, 0])).toEqual({ x: 0.3127, y: 0.329 });
  });

  test("light level to lux", () => {
    expect(lightLevelToLux(1)).toBe(1);
    expect(lightLevelToLux(20001)).toBe(100);
  });
});

describe("state bodies", () => {
  test("brightness implies on unless power says otherwise", () => {
    expect(buildStateBody({ brightness: 50 })).toEqual({ dimming: { brightness: 50 }, on: { on: true } });
    expect(buildStateBody({ brightness: 50, on: false })).toEqual({ dimming: { brightness: 50 }, on: { on: false } });
    expect(buildStateBody({ brightness: 0 })).toEqual({ on: { on: false } });
  });

  test("invalid combinations are rejected", () => {
    expect(() => buildStateBody({})).toThrow(/nothing to change/);
    expect(() => buildStateBody({ transition_ms: 100 })).toThrow(/nothing to change/);
    expect(() => buildStateBody({ kelvin: 3000, color: "red" })).toThrow(/either kelvin or color/);
    expect(() => buildStateBody({ brightness: 0, on: true })).toThrow(/turns the light off/);
    expect(() => buildStateBody({ kelvin: 9000 })).toThrow(/2000–6500/);
  });

  test("matching prefers ids, then case-insensitive names", () => {
    const items = [
      { id: "a", metadata: { name: "Lamp" } },
      { id: "b", metadata: { name: "lamp" } },
      { id: "Lamp", metadata: { name: "Other" } },
    ];
    expect(matchByIdOrName(items, "Lamp").map((i) => i.id)).toEqual(["Lamp"]);
    expect(matchByIdOrName(items, "LAMP").map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("row building", () => {
  const light = (id: string, owner: string, name: string, extra: Partial<HueLight> = {}): HueLight => ({
    id,
    owner: { rid: owner, rtype: "device" },
    metadata: { name },
    ...extra,
  });

  test("lights get rooms, reachability and colour mode; empty input gives no rows", () => {
    const cols = lightRows(
      [
        light("l2", "d2", "B", { color: { xy: { x: 0.5, y: 0.4 } }, color_temperature: { mirek: null } }),
        light("l1", "d1", "A", { on: { on: true }, color_temperature: { mirek: 250 } }),
      ],
      [],
      [{ id: "r", type: "room", metadata: { name: "Den" }, children: [{ rid: "d1", rtype: "device" }] }],
      [{ id: "z", owner: { rid: "d1", rtype: "device" }, status: "connected" }],
    );
    expect(cols.name).toEqual(["A", "B"]);
    expect(cols.room).toEqual(["Den", null]);
    expect(cols.color_mode).toEqual(["color_temperature", "xy"]);
    expect(cols.color_temperature_kelvin).toEqual([4000, null]);
    expect(cols.reachable).toEqual([true, null]);
    expect(lightRows([], [], [], []).light_id).toEqual([]);
  });

  test("zones list lights directly, rooms list devices", () => {
    const lights = [light("l1", "d1", "A"), light("l2", "d2", "B")];
    const cols = roomRows(
      [
        { id: "z", type: "zone", metadata: { name: "Z" }, children: [{ rid: "l2", rtype: "light" }] },
        { id: "r", type: "room", metadata: { name: "R" }, children: [{ rid: "d1", rtype: "device" }] },
      ],
      [],
      lights,
    );
    expect(cols.name).toEqual(["R", "Z"]);
    expect(cols.light_names).toEqual([["A"], ["B"]]);
  });
});

describe("against the mock bridge", () => {
  let mock: ReturnType<typeof Bun.spawn>;
  let conn: BridgeConnection;
  let client: VgiClient;

  beforeAll(async () => {
    mock = Bun.spawn([process.env.PYTHON ?? "python3", join(ROOT, "test", "mock_bridge", "server.py")], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, MOCK_FLAKY: "1" },
    });
    const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const port = text.match(/^PORT:(\d+)/)?.[1];
    if (!port) throw new Error(`mock bridge did not report a port: ${text}`);
    conn = { baseUrl: `http://127.0.0.1:${port}`, appKey: "test-key" };
    // The worker as DuckDB launches it, with the bridge given through its environment.
    client = new VgiClient(
      subprocessConnect([process.execPath, "run", join(ROOT, "src", "worker.ts")], {
        env: { HUE_BRIDGE: conn.baseUrl, HUE_APP_KEY: "test-key" },
      }),
    );
  });

  afterAll(() => {
    client?.close();
    mock?.kill();
  });

  test("discovery finds the mock through a discovery endpoint, and caches it", async () => {
    const cacheFile = join(tmpdir(), `vgi-hue-test-${process.pid}.json`);
    const env = {
      HUE_DISCOVERY_URL: `${conn.baseUrl}/discovery`,
      HUE_DISCOVERY_SCHEME: "http",
      HUE_DISCOVERY_MDNS: "off",
    };
    try {
      const found = await discoverBridge(null, { env, cacheFile });
      expect(found).toEqual({ id: "001788fffe00beef", name: "Mock bridge", url: conn.baseUrl });
      // With every source now returning nothing, it still resolves: from the cache.
      const again = await discoverBridge(null, { env, cacheFile, cloud: async () => [], mdns: async () => [] });
      expect(again.url).toBe(conn.baseUrl);
      await expect(
        discoverBridge(null, { env: { ...env, HUE_DISCOVERY_URL: `${conn.baseUrl}/discovery/none` }, cacheFile: null }),
      ).rejects.toThrow(/no Hue bridge found/);
    } finally {
      rmSync(cacheFile, { force: true });
    }
  });

  test("GET retries a 429 and returns data", async () => {
    const lights = await getResources<HueLight>(conn, "light");
    expect(lights.map((l) => l.id).sort()).toEqual(["l-ceiling", "l-desk", "l-pendant", "l-sofa"]);
  });

  test("errors carry the HTTP status", async () => {
    await expect(hueRequest({ ...conn, appKey: "nope" }, "GET", "/resource/light")).rejects.toThrow(/HTTP 403/);
    await expect(hueRequest(conn, "PUT", "/resource/light/missing", { on: { on: true } })).rejects.toThrow(/HTTP 404/);
  });

  test("unreachable bridge is reported clearly", async () => {
    await expect(hueRequest({ baseUrl: "http://127.0.0.1:1", appKey: "k" }, "GET", "/resource/light")).rejects.toThrow(
      /cannot reach the Hue bridge/,
    );
  }, 20_000);

  test("set_light, set_room and recall_scene change state", async () => {
    expect((await setLight(conn, "Sofa lamp", { on: true }))[0]?.target_id).toBe("l-sofa");
    expect((await setRoom(conn, "Living room", { brightness: 20 }))[0]?.target_type).toBe("room");
    const lights = await getResources<HueLight>(conn, "light");
    expect(lights.find((l) => l.id === "l-sofa")?.dimming?.brightness).toBe(20);
    await expect(recallScene(conn, "Relax", null)).rejects.toThrow(/several rooms/);
    expect((await recallScene(conn, "Bright", "kitchen"))[0]?.target_id).toBe("s-bright-kitchen");
  });

  test("the worker falls back to HUE_BRIDGE / HUE_APP_KEY", async () => {
    const rows: Record<string, unknown>[] = [];
    for await (const page of client.tableFunctionRows({
      functionName: "rooms_scan", // the scan behind the rooms table
      arguments: new Arguments([], new Map()),
      int64: "bigint",
    })) {
      rows.push(...page);
    }
    expect(rows.map((r) => r.name)).toEqual(["Hallway", "Kitchen", "Living room", "Downstairs"]);
  });
});

/** Start the mock bridge with extra environment; resolves to its base URL. */
async function startMock(env: Record<string, string>): Promise<{ url: string; proc: ReturnType<typeof Bun.spawn> }> {
  const proc = Bun.spawn([process.env.PYTHON ?? "python3", join(ROOT, "test", "mock_bridge", "server.py")], {
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, ...env },
  });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const port = text.match(/^PORT:(\d+)/)?.[1];
  if (!port) throw new Error(`mock bridge did not report a port: ${text}`);
  return { url: `http://127.0.0.1:${port}`, proc };
}

describe("state after a room command", () => {
  const light = (extra: Partial<HueLight>): HueLight => ({ id: "l", owner: { rid: "d", rtype: "device" }, ...extra });

  test("on/off and brightness must match; colour only needs the colour mode", () => {
    const on50 = light({ on: { on: true }, dimming: { brightness: 50 } });
    expect(lightReflects(on50, { on: { on: true }, dimming: { brightness: 50.4 } })).toBe(true);
    expect(lightReflects(on50, { on: { on: true }, dimming: { brightness: 80 } })).toBe(false);
    expect(lightReflects(on50, { on: { on: false } })).toBe(false);
    const xy = light({ on: { on: true }, color: { xy: { x: 0.15, y: 0.05 } }, color_temperature: { mirek: null } });
    // A bulb clamps blue to its gamut: a different xy still counts.
    expect(lightReflects(xy, { color: { xy: { x: 0.1355, y: 0.0399 } } })).toBe(true);
    expect(lightReflects(xy, { color_temperature: { mirek: 370 } })).toBe(false);
  });

  test("capabilities a light lacks are not waited for, nor anything on a light turned off", () => {
    const white = light({ on: { on: true }, dimming: { brightness: 10 } });
    expect(lightReflects(white, { color: { xy: { x: 0.7, y: 0.3 } } })).toBe(true);
    const off = light({ on: { on: false }, dimming: { brightness: 10 } });
    expect(lightReflects(off, { on: { on: false }, dimming: { brightness: 100 } })).toBe(true);
  });
});

describe("disabled sensors", () => {
  test("show no reading and no last_changed", () => {
    const cols = sensorRows(
      [
        {
          id: "t",
          type: "temperature",
          owner: { rid: "d", rtype: "device" },
          enabled: false,
          temperature: { temperature: 30, temperature_report: { changed: "2026-10-01T00:00:00Z", temperature: 30 } },
        },
        {
          id: "b",
          type: "device_power",
          owner: { rid: "d", rtype: "device" },
          power_state: { battery_level: 50, battery_state: "normal" },
        },
      ],
      [],
      [],
      [],
    );
    expect(cols.temperature_c).toEqual([null, null]);
    expect(cols.last_changed).toEqual([null, null]);
    expect(cols.battery_percent).toEqual([50, null]);
    expect(cols.enabled).toEqual([null, false]);
  });
});

describe("set_room wait_ms against a bridge that relays slowly", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  let conn: BridgeConnection;

  beforeAll(async () => {
    mock = await startMock({ MOCK_GROUP_DELAY_MS: "700" });
    conn = { baseUrl: mock.url, appKey: "test-key" };
  });
  afterAll(() => mock?.proc.kill());

  const kitchen = async () =>
    (await getResources<HueLight>(conn, "light"))
      .filter((l) => l.id === "l-ceiling" || l.id === "l-pendant")
      .map((l) => l.dimming?.brightness);

  test("without waiting, the lights still show the old state", async () => {
    const [row] = await setRoom(conn, "Kitchen", { brightness: 33 });
    expect(row?.settled).toBeNull();
    expect(await kitchen()).toEqual([80, 50]);
  });

  test("waiting long enough settles; too short a wait reports false", async () => {
    const [slow] = await setRoom(conn, "Kitchen", { brightness: 44 }, 3000);
    expect(slow?.settled).toBe(true);
    expect(await kitchen()).toEqual([44, 44]);
    const [quick] = await setRoom(conn, "Kitchen", { brightness: 55 }, 100);
    expect(quick?.settled).toBe(false);
  }, 15_000);
});

describe("UPDATE hue.main.lights", () => {
  test("rowids are stable, positive, and distinct", () => {
    const id = "5b859859-7f0d-460f-a587-28de40e03404";
    expect(lightRowId(id)).toBe(lightRowId(id));
    expect(lightRowId(id) > 0n && lightRowId(id) < 2n ** 62n).toBe(true);
    const ids = Array.from({ length: 2000 }, (_, i) => `light-${i}`);
    expect(new Set(ids.map(lightRowId)).size).toBe(ids.length);
  });

  const current = {
    light_id: "l",
    name: "Lamp",
    room: "Den",
    is_on: false,
    brightness: 30,
    color_mode: "color_temperature",
    color_temperature_kelvin: 4000,
    color_hex: "#ffcea6",
  };
  // DuckDB's input to the update function: changed columns (or all, with RETURNING) + rowid.
  const input = (cols: Record<string, unknown>) =>
    batchFromColumns(
      { ...Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, [v]])), rowid: [1n] },
      schema([
        ...Object.keys(cols).map((k) =>
          field(
            k,
            k === "is_on" ? bool : k === "brightness" ? float64() : k.endsWith("kelvin") ? int64() : utf8(),
            true,
          ),
        ),
        field("rowid", int64(), false),
      ]),
    );

  test("only values that differ from the light's current row are changes", () => {
    // RETURNING passes every column: unchanged ones (colour, kelvin, room) are ignored.
    const { change, name } = rowChange(
      input({
        name: "Lamp",
        room: "Den",
        is_on: true,
        brightness: 30,
        color_temperature_kelvin: 4000n,
        color_hex: "#FFCEA6",
      }),
      0,
      current,
    );
    expect(change).toEqual({ on: true });
    expect(name).toBeNull();
  });

  test("a changed read-only column is refused; NULL and bad names too", () => {
    expect(() => rowChange(input({ room: "Attic" }), 0, current)).toThrow(/cannot UPDATE 'room'/);
    expect(() => rowChange(input({ brightness: null }), 0, current)).toThrow(/NULL/);
    expect(() => rowChange(input({ name: "x".repeat(33) }), 0, current)).toThrow(/1-32/);
    expect(() => checkKnownColumns(["nope", "rowid"])).toThrow(/no column 'nope'/);
  });

  test("the PUT body and the row RETURNING shows", () => {
    expect(updateBody({}, "Reading")).toEqual({ metadata: { name: "Reading" } });
    const body = updateBody({ kelvin: 2700 }, null);
    expect(body).toEqual({ color_temperature: { mirek: 370 } });
    expect(applyToRow(current, body)).toMatchObject({
      color_temperature_kelvin: 2703,
      color_mode: "color_temperature",
    });
    const red = applyToRow(current, updateBody({ color: "red", on: true }, null));
    expect(red).toMatchObject({ is_on: true, color_mode: "xy", color_temperature_kelvin: null, color_hex: "#ff0000" });
  });
});
