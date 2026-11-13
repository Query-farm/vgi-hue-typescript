// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Arguments,
  AttachOptionsUnavailableError,
  batchFromColumns,
  bool,
  field,
  float64,
  int64,
  list,
  schema,
  struct,
  utf8,
  VgiClient,
  type VgiDataType,
} from "@query-farm/vgi";
import { subprocessConnect } from "@query-farm/vgi-rpc";
import { bridgeOptionsFrom, decodeAttachOptions } from "../src/attach.ts";
import {
  gradientColors,
  lightReflects,
  matchByIdOrName,
  recallScene,
  setGradient,
  setLight,
  setRoom,
} from "../src/control.ts";
import { candidateUrl, chooseBridge, discoverBridge, isBridgeId, mdnsQuery } from "../src/discovery.ts";
import { immediate } from "../src/dispatch.ts";
import {
  type BridgeConnection,
  buildStateBody,
  getResources,
  HueError,
  type HueLight,
  hueRequest,
  kelvinToMirek,
  LIGHT_COMMAND_GAP_MS,
  lightLevelToLux,
  MAX_IN_FLIGHT,
  parseColor,
  putAll,
  resolveConnection,
  rgbToXy,
  xyToHex,
} from "../src/hue.ts";
import { lightRowId, lightRows, roomRows, sensorRows } from "../src/inventory.ts";
import {
  applyToRow,
  checkKnownColumns,
  lightCaps,
  lightUpdateRequests,
  rowChange,
  updateBody,
  updateRequests,
} from "../src/lights_write.ts";
import {
  beginTransaction,
  coalesce,
  commitTransaction,
  type StagedRequest,
  stage,
  stageable,
} from "../src/transactions.ts";

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

  test("bridge options come from the ATTACH options (trimmed, blanks dropped)", () => {
    expect(bridgeOptionsFrom({ bridge: " 1.2.3.4 ", app_key: "k", other: 5 })).toEqual({
      bridge: "1.2.3.4",
      app_key: "k",
    });
    expect(bridgeOptionsFrom({ bridge: "  ", transactional: true })).toEqual({ transactional: true });
    expect(bridgeOptionsFrom(undefined)).toEqual({});
    // No attach (a call outside one): no options.
    expect(decodeAttachOptions(null)).toEqual({});
  });

  test("attach bytes the SDK did not hand out are refused, not read as options", () => {
    expect(() => decodeAttachOptions(new Uint8Array([1, 2, 3]))).toThrow(AttachOptionsUnavailableError);
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
    expect(lights.map((l) => l.id).sort()).toEqual(["l-ceiling", "l-desk", "l-pendant", "l-sofa", "l-strip"]);
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

  test("set_gradient sends the points and mode; a light without a gradient sends nothing", async () => {
    const [row] = await setGradient(conn, "hallway strip", gradientColors(["#ff0000", "blue"]), "segmented_palette");
    expect(row).toMatchObject({ target_type: "light", target_id: "l-strip", ok: true });
    expect(JSON.parse(row?.request ?? "")).toEqual({
      gradient: {
        points: [{ color: { xy: { x: 0.7006, y: 0.2993 } } }, { color: { xy: { x: 0.1355, y: 0.0399 } } }],
        mode: "segmented_palette",
      },
    });
    const strip = (await getResources<HueLight>(conn, "light")).find((l) => l.id === "l-strip");
    expect(strip?.gradient?.mode).toBe("segmented_palette");
    expect(strip?.gradient?.points?.length).toBe(2);
    await expect(setGradient(conn, "Sofa lamp", [{ x: 0.3, y: 0.3 }])).rejects.toThrow(
      "light 'Sofa lamp' does not support gradients",
    );
    const six = gradientColors(["red", "green", "blue", "red", "green", "blue"]);
    await expect(setGradient(conn, "Hallway strip", six)).rejects.toThrow(
      "light 'Hallway strip' takes 2–5 gradient points, got 6",
    );
    const before = (await getResources<HueLight>(conn, "light")).find((l) => l.id === "l-strip")?.gradient;
    await expect(setGradient(conn, "Hallway strip", six.slice(0, 1))).rejects.toThrow(
      "light 'Hallway strip' takes 2–5 gradient points, got 1",
    );
    await expect(setGradient(conn, "Hallway strip", [])).rejects.toThrow("got 0");
    expect((await getResources<HueLight>(conn, "light")).find((l) => l.id === "l-strip")?.gradient).toEqual(before);
    await expect(setGradient(conn, "Hallway strip", six.slice(0, 2), "swirl")).rejects.toThrow(
      /invalid gradient_mode 'swirl' for light 'Hallway strip'; allowed: interpolated_palette, /,
    );
    expect(() => gradientColors([])).toThrow("set_gradient needs at least two colours");
    expect(() => gradientColors(["#ff0000", null])).toThrow("gradient points must not be NULL");
  });

  test("the mock refuses invalid gradient, effect and xy PUTs like a bridge (HTTP 400)", async () => {
    const put = (id: string, body: unknown) => hueRequest(conn, "PUT", `/resource/light/${id}`, body);
    await expect(put("l-strip", { gradient: { mode: "segmented_palette" } })).rejects.toThrow(
      /HTTP 400: gradient.points is required/,
    );
    const xy = { color: { xy: { x: 0.3, y: 0.3 } } };
    await expect(put("l-strip", { gradient: { points: Array(6).fill(xy) } })).rejects.toThrow(/at most 5 points/);
    await expect(put("l-strip", { gradient: { points: [xy] } })).rejects.toThrow(
      /HTTP 400: invalid attribute value \(\.gradient\.points\)/,
    );
    await expect(put("l-strip", { gradient: { points: [] } })).rejects.toThrow(/HTTP 400: invalid attribute value/);
    await expect(put("l-strip", { gradient: { points: [xy, xy], mode: "swirl" } })).rejects.toThrow(/gradient.mode/);
    await expect(put("l-sofa", { gradient: { points: [xy] } })).rejects.toThrow(/does not support gradient/);
    await expect(put("l-sofa", { effects: { effect: "disco" } })).rejects.toThrow(/effects.effect: invalid value/);
    await expect(put("l-pendant", { effects: { effect: "candle" } })).rejects.toThrow(/does not support effects/);
    await expect(put("l-sofa", { color: { xy: { x: 1.5, y: 0.3 } } })).rejects.toThrow(/color.xy: invalid value/);
    await put("l-sofa", { effects: { effect: "candle" } });
    const sofa = (await getResources<HueLight>(conn, "light")).find((l) => l.id === "l-sofa");
    expect(sofa?.effects?.status).toBe("candle");
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
    // A bridge ignores state sent with metadata: the rename is its own request.
    expect(updateRequests(updateBody({ brightness: 50 }, "Reading"))).toEqual([
      { dimming: { brightness: 50 }, on: { on: true } },
      { metadata: { name: "Reading" } },
    ]);
    expect(updateRequests({})).toEqual([]);
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

describe("UPDATE hue.main.lights: xy colours, gradients and effects", () => {
  const XY = struct([field("x", float64()), field("y", float64())]);
  const TYPES: Record<string, VgiDataType> = {
    color_x: float64(),
    color_y: float64(),
    color_temperature_kelvin: int64(),
    gradient_hex: list(utf8()),
    gradient_xy: list(XY),
  };
  const input = (cols: Record<string, unknown>) =>
    batchFromColumns(
      { ...Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, [v]])), rowid: [1n] },
      schema([...Object.keys(cols).map((k) => field(k, TYPES[k] ?? utf8(), true)), field("rowid", int64(), false)]),
    );
  const EFFECTS = ["no_effect", "candle", "fire"];
  const MODES = ["interpolated_palette", "segmented_palette"];
  const stripLight: HueLight = {
    id: "l-strip",
    owner: { rid: "d", rtype: "device" },
    metadata: { name: "Strip" },
    color: { xy: { x: 0.3, y: 0.3 } },
    gradient: {
      points: [{ color: { xy: { x: 0.7006, y: 0.2993 } } }, { color: { xy: { x: 0.1355, y: 0.0399 } } }],
      points_capable: 3,
      mode: "interpolated_palette",
      mode_values: MODES,
      pixel_count: 10,
    },
    effects: { status: "no_effect", effect_values: EFFECTS },
  };
  const strip = lightRows([stripLight], [], [], []);
  const stripRow = Object.fromEntries(Object.entries(strip).map(([k, v]) => [k, v[0]]));
  const caps = lightCaps(stripLight);
  const white = lightCaps({ id: "w", owner: { rid: "d", rtype: "device" }, metadata: { name: "White" } });
  const change = (cols: Record<string, unknown>, c = caps) => rowChange(input(cols), 0, stripRow, c).change;

  test("the strip's row: gradient columns and effect", () => {
    expect(stripRow).toMatchObject({
      gradient_hex: ["#ff0000", "#0000ff"],
      gradient_xy: [
        { x: 0.7006, y: 0.2993 },
        { x: 0.1355, y: 0.0399 },
      ],
      gradient_mode: "interpolated_palette",
      gradient_points_capable: 3,
      gradient_pixel_count: 10,
      effect: "no_effect",
    });
    const plainLight = lightRows([{ id: "p", owner: { rid: "d", rtype: "device" } }], [], [], []);
    expect([plainLight.gradient_hex, plainLight.gradient_xy, plainLight.effect]).toEqual([[null], [null], [null]]);
  });

  test("color_x / color_y: both, or one with the other kept; sent without a hex round trip", () => {
    expect(change({ color_x: 0.17, color_y: 0.7 })).toEqual({ xy: { x: 0.17, y: 0.7 } });
    expect(change({ color_y: 0.5 })).toEqual({ xy: { x: 0.3, y: 0.5 } });
    // RETURNING passes unchanged columns too: they are no change.
    expect(change({ color_x: 0.3, color_y: 0.3, gradient_hex: ["#FF0000", "#0000ff"] })).toEqual({});
    expect(buildStateBody({ xy: { x: 0.17, y: 0.7 } })).toEqual({ color: { xy: { x: 0.17, y: 0.7 } } });
    const row = applyToRow(stripRow, buildStateBody({ xy: { x: 0.17, y: 0.7 } }));
    expect(row).toMatchObject({ color_mode: "xy", color_x: 0.17, color_y: 0.7, gradient_hex: [], gradient_xy: [] });
  });

  test("xy errors: with color_hex, out of range, a light without colour", () => {
    expect(() => change({ color_hex: "#ff0000", color_x: 0.2 })).toThrow(
      "set either color_hex or color_x/color_y, not both",
    );
    expect(() => change({ color_x: 1.5 })).toThrow("color_x must be 0–1, got 1.5");
    expect(() => change({ color_y: -0.1 })).toThrow("color_y must be 0–1, got -0.1");
    expect(() => change({ color_x: 0.2 }, white)).toThrow("light 'White' does not support color");
    expect(() => buildStateBody({ xy: { x: 0.2, y: 0.2 }, color: "red" })).toThrow(/not both/);
  });

  test("gradient_hex and gradient_xy become points; gradient_mode alone re-sends the current points", () => {
    expect(change({ gradient_hex: ["#ff0000", "green"] })).toEqual({
      gradient: {
        points: [
          { x: 0.7006, y: 0.2993 },
          { x: 0.1724, y: 0.7468 },
        ],
      },
    });
    const two = [
      { x: 0.2, y: 0.3 },
      { x: 0.6, y: 0.35 },
    ];
    expect(change({ gradient_xy: two, gradient_mode: "segmented_palette" })).toEqual({
      gradient: { points: two, mode: "segmented_palette" },
    });
    const modeOnly = change({ gradient_mode: "segmented_palette" });
    expect(modeOnly.gradient).toEqual({ points: stripRow.gradient_xy as never, mode: "segmented_palette" });
    const body = buildStateBody(modeOnly);
    expect(body).toEqual({
      gradient: {
        points: [{ color: { xy: { x: 0.7006, y: 0.2993 } } }, { color: { xy: { x: 0.1355, y: 0.0399 } } }],
        mode: "segmented_palette",
      },
    });
    const greenBlue = [
      { x: 0.1724, y: 0.7468 },
      { x: 0.1355, y: 0.0399 },
    ];
    // The bridge sets the light's colour to the first point: RETURNING reports it.
    expect(applyToRow(stripRow, buildStateBody(change({ gradient_xy: greenBlue })))).toMatchObject({
      gradient_hex: ["#00ff00", "#0000ff"],
      gradient_xy: greenBlue,
      gradient_mode: "interpolated_palette",
      color_mode: "xy",
      color_temperature_kelvin: null,
      color_x: 0.1724,
      color_y: 0.7468,
      color_hex: "#00ff00",
    });
  });

  test("gradient errors", () => {
    const four = ["#ff0000", "#00ff00", "#0000ff", "#ffffff"];
    expect(() => change({ gradient_hex: four })).toThrow("light 'Strip' takes 2–3 gradient points, got 4");
    expect(() => change({ gradient_hex: [] })).toThrow("got 0");
    expect(() => change({ gradient_hex: ["#ff0000"] })).toThrow("light 'Strip' takes 2–3 gradient points, got 1");
    expect(() => change({ gradient_xy: [{ x: 0.2, y: 0.3 }] })).toThrow("got 1");
    // gradient_mode alone on a light whose gradient was cleared (a single colour): nothing to re-send.
    const cleared = { ...stripRow, gradient_hex: [], gradient_xy: [] };
    expect(() => rowChange(input({ gradient_mode: "segmented_palette" }), 0, cleared, caps)).toThrow(
      "light 'Strip' has no gradient to change the mode of; set gradient_hex or gradient_xy too",
    );
    // ...but with new points in the same statement it goes through.
    expect(
      rowChange(input({ gradient_mode: "segmented_palette", gradient_hex: ["#ff0000", "#0000ff"] }), 0, cleared, caps)
        .change.gradient?.mode,
    ).toBe("segmented_palette");
    expect(() => change({ gradient_mode: "swirl" })).toThrow(
      "invalid gradient_mode 'swirl' for light 'Strip'; allowed: interpolated_palette, segmented_palette",
    );
    expect(() => change({ gradient_hex: ["#ff0000"] }, white)).toThrow("light 'White' does not support gradients");
    expect(() => change({ gradient_hex: ["#ff0000"], color_hex: "#00ff00" })).toThrow(
      "set either a gradient or a single colour (color_hex, color_x/color_y, color_temperature_kelvin), not both",
    );
    expect(() => change({ gradient_mode: "segmented_palette", color_temperature_kelvin: 3000n })).toThrow(
      /single colour/,
    );
    expect(() => change({ gradient_hex: ["#ff0000"], gradient_xy: [{ x: 0.1, y: 0.1 }] })).toThrow(
      "set either gradient_hex or gradient_xy, not both",
    );
    expect(() => change({ gradient_hex: ["#ff0000", null] })).toThrow("gradient points must not be NULL");
    expect(() => change({ gradient_xy: [{ x: 0.1, y: null }] })).toThrow("gradient points must not be NULL");
    expect(() => change({ gradient_xy: [{ x: 1.5, y: 0.3 }] })).toThrow("gradient x and y must be 0–1, got (1.5, 0.3)");
    expect(() => change({ gradient_hex: ["#zz"] })).toThrow(/invalid color '#zz'/);
    expect(() => change({ gradient_xy: null })).toThrow("cannot SET gradient_xy = NULL on a light");
    expect(() => change({ gradient_pixel_count: "3" })).toThrow(/cannot UPDATE 'gradient_pixel_count'/);
  });

  test("effect: set, clear, refused values and lights without effects", () => {
    expect(change({ effect: "candle" })).toEqual({ effect: "candle" });
    expect(buildStateBody({ effect: "no_effect" })).toEqual({ effects: { effect: "no_effect" } });
    expect(applyToRow(stripRow, { effects: { effect: "fire" } })).toMatchObject({ effect: "fire" });
    expect(() => change({ effect: "disco" })).toThrow(
      "invalid effect 'disco' for light 'Strip'; allowed: no_effect, candle, fire",
    );
    expect(() => change({ effect: "candle" }, white)).toThrow("light 'White' does not support effects");
  });

  test("a gradient, an effect and other state go in one request; a rename in its own", () => {
    const body = buildStateBody({ on: true, gradient: { points: [{ x: 0.1, y: 0.2 }] }, effect: "candle" });
    expect(updateRequests(updateBody({ on: true, effect: "candle" }, "New"))).toEqual([
      { on: { on: true }, effects: { effect: "candle" } },
      { metadata: { name: "New" } },
    ]);
    expect(body).toEqual({
      on: { on: true },
      gradient: { points: [{ color: { xy: { x: 0.1, y: 0.2 } } }] },
      effects: { effect: "candle" },
    });
  });
});

describe("transactions", () => {
  const light = (target: string, body: Record<string, unknown>) => ({ kind: "light" as const, target, body });

  test("a colour replaces a staged gradient and a gradient a staged colour", () => {
    const g = { gradient: { points: [{ color: { xy: { x: 0.1, y: 0.2 } } }] } };
    expect(coalesce([light("s", g), light("s", { color: { xy: { x: 0.3, y: 0.3 } } })])).toEqual([
      light("s", { color: { xy: { x: 0.3, y: 0.3 } } }),
    ]);
    expect(
      coalesce([light("s", { color_temperature: { mirek: 300 }, effects: { effect: "fire" } }), light("s", g)]),
    ).toEqual([light("s", { effects: { effect: "fire" }, ...g })]);
  });

  test("back-to-back changes to one light merge; colour replaces white temperature", () => {
    expect(
      coalesce([
        light("a", { dimming: { brightness: 10 } }),
        light("a", { color_temperature: { mirek: 370 } }),
        light("a", { color: { xy: { x: 0.1, y: 0.2 } } }),
      ]),
    ).toEqual([light("a", { dimming: { brightness: 10 }, color: { xy: { x: 0.1, y: 0.2 } } })]);
  });

  test("renames, other lights and room commands keep their own requests, in order", () => {
    const group = { kind: "grouped_light" as const, target: "g", body: { on: { on: false } } };
    const merged = coalesce([
      light("a", { on: { on: true } }),
      light("a", { metadata: { name: "x" } }),
      light("a", { dimming: { brightness: 5 } }),
      group,
      light("b", { on: { on: true } }),
    ]);
    expect(merged.map((r) => `${r.kind}:${r.target}`)).toEqual([
      "light:a",
      "light:a",
      "light:a",
      "grouped_light:g",
      "light:b",
    ]);
  });

  test("staging needs a transactional attach and a plaintext id", () => {
    const id = new Uint8Array(16);
    expect(stageable(false, id)).toBeNull();
    expect(stageable(true, null)).toBeNull();
    expect(stageable(true, id)).toBe(id);
    expect(() => stageable(true, new Uint8Array(73))).toThrow(/0.48.4 or later/);
  });
});

// --------------------------------------------------- pipelined PUTs (putAll)

interface PutLog {
  path: string;
  body: Record<string, unknown>;
  start: number;
  end: number | null;
}

const putLog = async (url: string): Promise<PutLog[]> => (await fetch(`${url}/debug/puts`)).json() as Promise<PutLog[]>;
const clearPutLog = (url: string) => fetch(`${url}/debug/puts`, { method: "DELETE" });
const benchLight = (n: number, body: Record<string, unknown> = { on: { on: true } }): StagedRequest => ({
  kind: "light",
  target: `l-bench-${n}`,
  body,
});
/** Commit tests stage in a private SQLite file, not the shared default. */
const privateTxDir = () => {
  process.env.HUE_TX_DIR = join(tmpdir(), `vgi-hue-test-tx-${process.pid}`);
};
const twelve = () => Array.from({ length: 12 }, (_, i) => benchLight(i + 1));
/** Most requests the bridge had open at the same time. */
const maxOverlap = (log: PutLog[]) =>
  Math.max(...log.map((a) => log.filter((b) => b.start <= a.start && (b.end ?? Infinity) > a.start).length));
/** Smallest gap between consecutive request starts, in ms. */
const minStartGapMs = (log: PutLog[]) => {
  const starts = log.map((e) => e.start).sort((a, b) => a - b);
  return Math.min(...starts.slice(1).map((s, i) => (s - (starts[i] as number)) * 1000));
};

/**
 * When the worker itself started each PUT (performance.now() ms), recorded by
 * wrapping fetch: the bridge sees them later, with its own scheduling jitter.
 */
async function clientPutStarts(run: () => Promise<unknown>): Promise<number[]> {
  const real = globalThis.fetch;
  const starts: number[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === "PUT") starts.push(performance.now());
    return real(input, init);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
  return starts;
}

/** Starts honour the pace: each gap is ~the light gap, and n starts span at least (n-1) gaps. */
function expectPaced(starts: number[]) {
  const gaps = starts.slice(1).map((t, i) => t - (starts[i] as number));
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(LIGHT_COMMAND_GAP_MS - 10); // timer jitter
  for (let i = 1; i < starts.length; i++) {
    expect((starts[i] as number) - (starts[0] as number)).toBeGreaterThanOrEqual(i * LIGHT_COMMAND_GAP_MS - 2);
  }
}

describe("pipelined light PUTs (300 ms per request)", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  let conn: BridgeConnection;
  beforeAll(async () => {
    privateTxDir();
    mock = await startMock({ MOCK_EXTRA_LIGHTS: "12", MOCK_LIGHT_DELAY_MS: "300" });
    conn = { baseUrl: mock.url, appKey: "test-key" };
  });
  afterAll(() => mock?.proc.kill());

  test("12 lights overlap their round trips, but starts stay paced", async () => {
    await clearPutLog(mock.url);
    const t0 = performance.now();
    const starts = await clientPutStarts(() => immediate(conn)(twelve()));
    const ms = performance.now() - t0;
    expect(starts).toHaveLength(12);
    expectPaced(starts);
    // Sequential would be 12 x 300 = 3600 ms; pipelined is ~11 gaps + one round trip.
    const ideal = 11 * LIGHT_COMMAND_GAP_MS + 300;
    expect(ms).toBeLessThan(12 * 300 * 0.65);
    expect(ms).toBeGreaterThanOrEqual(ideal - 30);
    const log = await putLog(mock.url);
    expect(log).toHaveLength(12);
    expect(minStartGapMs(log)).toBeGreaterThanOrEqual(LIGHT_COMMAND_GAP_MS - 40); // as the bridge saw them
    expect(maxOverlap(log)).toBeGreaterThan(1);
    expect(maxOverlap(log)).toBeLessThanOrEqual(MAX_IN_FLIGHT);
  }, 15_000);

  test("a light's own requests stay in order (state change, then rename)", async () => {
    await clearPutLog(mock.url);
    const requests = lightUpdateRequests([
      { old: { light_id: "l-bench-1" }, body: { on: { on: false }, metadata: { name: "Renamed 1" } } },
      { old: { light_id: "l-bench-2" }, body: { on: { on: false } } },
      { old: { light_id: "l-bench-3" }, body: { on: { on: false } } },
    ]);
    expect(requests.map((r) => r.target)).toEqual(["l-bench-1", "l-bench-1", "l-bench-2", "l-bench-3"]);
    await immediate(conn)(requests);
    const log = await putLog(mock.url);
    const one = log.filter((e) => e.path.endsWith("/l-bench-1"));
    expect(one.map((e) => Object.keys(e.body))).toEqual([["on"], ["metadata"]]);
    expect(one[1]?.start).toBeGreaterThanOrEqual(one[0]?.end as number);
    // The other lights did not wait for light 1's first round trip.
    const two = log.find((e) => e.path.endsWith("/l-bench-2"));
    expect(two?.start).toBeLessThan(one[0]?.end as number);
    const lights = await getResources<HueLight>(conn, "light");
    expect(lights.find((l) => l.id === "l-bench-1")?.metadata?.name).toBe("Renamed 1");
  }, 15_000);

  test("a group command waits for the light commands before it, and runs alone", async () => {
    await clearPutLog(mock.url);
    await putAll(conn, [
      benchLight(1),
      benchLight(2),
      { kind: "grouped_light", target: "gl-bench", body: { on: { on: true } } },
      benchLight(3),
    ]);
    const log = await putLog(mock.url);
    const group = log.find((e) => e.path.includes("grouped_light")) as PutLog;
    const lightsBefore = log.filter((e) => /l-bench-[12]$/.test(e.path));
    const after = log.find((e) => e.path.endsWith("/l-bench-3")) as PutLog;
    for (const e of lightsBefore) expect(group.start).toBeGreaterThanOrEqual(e.end as number);
    expect(after.start).toBeGreaterThanOrEqual(group.end as number);
  }, 15_000);

  test("COMMIT replays staged requests pipelined", async () => {
    const tx = beginTransaction();
    stage(
      tx,
      twelve().map((r) => ({ ...r, body: { dimming: { brightness: 25 } } })),
    );
    await clearPutLog(mock.url);
    const t0 = performance.now();
    const starts = await clientPutStarts(() => commitTransaction(async () => conn, tx));
    const ms = performance.now() - t0;
    expect(starts).toHaveLength(12);
    expectPaced(starts);
    const log = await putLog(mock.url);
    expect(log).toHaveLength(12);
    expect(ms).toBeLessThan(12 * 300 * 0.75); // includes the commit's own GETs
    expect(minStartGapMs(log)).toBeGreaterThanOrEqual(LIGHT_COMMAND_GAP_MS - 40); // as the bridge saw them
    expect(maxOverlap(log)).toBeGreaterThan(1);
  }, 15_000);
});

describe("pipelined light PUTs: the in-flight cap", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  beforeAll(async () => {
    mock = await startMock({ MOCK_EXTRA_LIGHTS: "12", MOCK_LIGHT_DELAY_MS: "800" });
  });
  afterAll(() => mock?.proc.kill());

  test(`a slow bridge never has more than ${MAX_IN_FLIGHT} requests open`, async () => {
    await immediate({ baseUrl: mock.url, appKey: "test-key" })(twelve());
    const log = await putLog(mock.url);
    expect(log).toHaveLength(12);
    expect(maxOverlap(log)).toBe(MAX_IN_FLIGHT);
  }, 20_000);
});

describe("pipelined light PUTs: a failure part-way", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  let conn: BridgeConnection;
  beforeAll(async () => {
    privateTxDir();
    mock = await startMock({ MOCK_EXTRA_LIGHTS: "12", MOCK_LIGHT_DELAY_MS: "300", MOCK_FAIL_LIGHT: "l-bench-5" });
    conn = { baseUrl: mock.url, appKey: "test-key" };
  });
  afterAll(() => mock?.proc.kill());

  test("starts nothing after the failure, lets in-flight requests finish, throws the first error", async () => {
    await clearPutLog(mock.url);
    const sent: string[] = [];
    const err = await putAll(conn, twelve(), (r) => sent.push(r.target)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HueError);
    expect((err as Error).message).toMatch(/^PUT \/resource\/light\/l-bench-5 failed with HTTP 500/);
    const log = await putLog(mock.url);
    const failed = log.find((e) => e.path.endsWith("/l-bench-5")) as PutLog;
    expect(log.length).toBeLessThan(12);
    expect(log.every((e) => e.end !== null)).toBe(true); // nothing still in flight when it threw
    for (const e of log) expect(e.start).toBeLessThan((failed.end as number) + 0.05);
    // Requests started after the failing one (still in flight then) were applied, and counted.
    expect(sent.length).toBe(log.length - 1);
    expect(sent).toContain("l-bench-6");
  }, 15_000);

  test("an UPDATE-style batch fails with the same error type", async () => {
    await expect(immediate(conn)(twelve())).rejects.toThrow(/HTTP 500/);
  }, 15_000);

  test("COMMIT reports the first error and restores the lights it changed", async () => {
    const tx = beginTransaction();
    stage(
      tx,
      twelve().map((r) => ({ ...r, body: { dimming: { brightness: 77 } } })),
    );
    await clearPutLog(mock.url);
    const err = (await commitTransaction(async () => conn, tx).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(HueError);
    expect(err.message).toMatch(
      /^COMMIT failed after \d+ of 12 light changes: PUT \/resource\/light\/l-bench-5 failed with HTTP 500/,
    );
    expect(err.message).toMatch(/Restored \d+ light\(s\)/);
    const lights = await getResources<HueLight>(conn, "light");
    expect(lights.filter((l) => l.dimming?.brightness === 77)).toEqual([]);
  }, 30_000);
});
