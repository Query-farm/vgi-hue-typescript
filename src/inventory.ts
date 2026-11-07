/**
 * Inventory tables: lights, rooms, scenes, sensors. `lights` also accepts
 * UPDATE (see lights_write.ts); the others are read-only.
 *
 * Each call fetches the bridge resources it needs (in parallel), joins them
 * into rows, and emits one batch: a home has at most a few hundred lights, so
 * there is nothing to page through. Binding never touches the network.
 */

import {
  batchFromColumns,
  bool,
  constraintRecord,
  defineTableFunction,
  float64,
  int32,
  list,
  rowIdField,
  schema,
  type TableDescriptor,
  type TableProcessParams,
  timestampMicros,
  utf8,
  type VgiFunction,
  type VgiSchema,
} from "@query-farm/vgi";
import { connectionFor, decodeAttachOptions } from "./attach.ts";
import {
  getResources,
  type HueDevice,
  type HueGroup,
  type HueGroupedLight,
  type HueLight,
  type HueScene,
  type HueSensor,
  type HueZigbee,
  kelvinToHex,
  lightLevelToLux,
  lightsInGroup,
  mirekToKelvin,
  reachableByDevice,
  roomByDevice,
  xyToHex,
} from "./hue.ts";
import { objectTags, resultColumns } from "./meta.ts";
import { pendingLightBodies, stageable } from "./transactions.ts";

type Columns = Record<string, unknown[]>;
type Row = Record<string, unknown>;
interface DoneState {
  done: boolean;
}

type ScanParams = TableProcessParams<Record<string, never>>;

interface InventoryConfig {
  name: string;
  description: string;
  columns: VgiSchema;
  load: (params: ScanParams) => Promise<Columns>;
  tags: Record<string, string>;
  examples: { sql: string; description: string }[];
  /** Column that identifies a row; declared as the table's primary key. */
  primaryKey: string;
  /** Columns the bridge always fills, besides the key; declared NOT NULL. */
  notNull: string[];
  /**
   * Give the table a `rowid` column so it can accept UPDATE/DELETE. `load`
   * must then fill `rowid`. DuckDB reads it as a virtual column, which needs
   * a scan with projection pushdown that is listed in the schema's functions,
   * so the scan is built that way (see `scanTags`).
   */
  rowId?: boolean;
  /** Discovery metadata for the listed scan function (required with `rowId`). */
  scanTags?: Record<string, string>;
  scanExamples?: { sql: string; description: string }[];
  /** Examples that run without a bridge (they only read the table's shape). */
  executableExamples?: { description: string; sql: string; expected_result: Record<string, string>[] }[];
}

/**
 * A catalog table (`SELECT * FROM hue.main.lights`) backed by a scan function.
 * The scan function is not listed in the schema, only registered for the table.
 */
function inventoryTable(config: InventoryConfig): { fn: VgiFunction; table: TableDescriptor } {
  const columns = config.rowId ? schema([...config.columns.fields, rowIdField()]) : config.columns;
  const fn = defineTableFunction<Record<string, never>, DoneState>({
    name: `${config.name}_scan`,
    description: config.rowId
      ? `Every row of the ${config.name} table, with its rowid (what UPDATE uses)`
      : `Backing scan for the ${config.name} table`,
    ...(config.rowId
      ? { projectionPushdown: true, tags: config.scanTags ?? {}, examples: config.scanExamples ?? [] }
      : {}),
    onBind: () => ({ outputSchema: columns }),
    initialState: () => ({ done: false }),
    process: async (params, state, out) => {
      if (state.done) {
        out.finish();
        return;
      }
      out.emit(batchFromColumns(await config.load(params), params.outputSchema));
      state.done = true;
    },
  });
  const table: TableDescriptor = {
    name: config.name,
    comment: config.description,
    columns,
    function: fn,
    constraints: [
      ...[config.primaryKey, ...config.notNull].map((col) =>
        constraintRecord({
          schemaPath: ["main"],
          table: config.name,
          id: `${col}_not_null`,
          kind: "NOT_NULL",
          columns: [[col]],
          enforcement: "ENFORCED",
          validation: "ALL_ROWS",
        }),
      ),
      constraintRecord({
        schemaPath: ["main"],
        table: config.name,
        id: "pk",
        kind: "PRIMARY_KEY",
        columns: [[config.primaryKey]],
        enforcement: "ENFORCED",
        validation: "ALL_ROWS",
      }),
    ],
    tags: {
      ...config.tags,
      domain: "smart home",
      "vgi.example_queries": JSON.stringify(config.examples),
      ...(config.executableExamples ? { "vgi.executable_examples": JSON.stringify(config.executableExamples) } : {}),
    },
  };
  return { fn, table };
}

const conn = (params: ScanParams) => connectionFor(params.initCall.bind_call);

/** The row as it reads once the bridge has applied `body` (what RETURNING and pending reads show). */
export function applyToRow(old: Row, body: Record<string, unknown>): Row {
  const row = { ...old };
  const b = body as {
    on?: { on: boolean };
    dimming?: { brightness: number };
    color_temperature?: { mirek: number };
    color?: { xy: { x: number; y: number } };
    metadata?: { name: string };
  };
  if (b.on) row.is_on = b.on.on;
  if (b.dimming) row.brightness = b.dimming.brightness;
  if (b.color_temperature) {
    const kelvin = mirekToKelvin(b.color_temperature.mirek);
    Object.assign(row, {
      color_mode: "color_temperature",
      color_temperature_kelvin: kelvin,
      color_hex: kelvinToHex(kelvin),
    });
  }
  if (b.color) {
    const { x, y } = b.color.xy;
    Object.assign(row, {
      color_mode: "xy",
      color_temperature_kelvin: null,
      color_x: x,
      color_y: y,
      color_hex: xyToHex(x, y),
    });
  }
  if (b.metadata) row.name = b.metadata.name;
  return row;
}

const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((i) => [i.id, i]));

/**
 * Inside a transaction of a transactional attach, show that transaction's
 * staged light changes on top of the bridge's state (read your own writes).
 * Staged room commands and scenes are not projected onto their lights.
 */
export function withPendingChanges(
  cols: Columns,
  bindCall: { attach_opaque_data?: Uint8Array | null; transaction_opaque_data?: Uint8Array | null },
): Columns {
  const txId = stageable(
    decodeAttachOptions(bindCall.attach_opaque_data).transactional === true,
    bindCall.transaction_opaque_data,
  );
  if (!txId) return cols;
  const pending = pendingLightBodies(txId);
  if (!pending.size) return cols;
  const names = Object.keys(cols);
  (cols.light_id ?? []).forEach((id, i) => {
    const bodies = pending.get(String(id));
    if (!bodies) return;
    const row = bodies.reduce(
      (acc, body) => applyToRow(acc, body),
      Object.fromEntries(names.map((n) => [n, cols[n]?.[i] ?? null])) as Row,
    );
    for (const n of names) if (cols[n]) cols[n][i] = row[n] ?? null;
  });
  return cols;
}

// ------------------------------------------------------------------- lights()

export const LIGHTS = resultColumns([
  ["light_id", utf8(), "VARCHAR", "Light id (CLIP v2 UUID); pass it to set_light.", false],
  ["name", utf8(), "VARCHAR", "Light name set in the Hue app."],
  ["room", utf8(), "VARCHAR", "Name of the room the light's device is in, or NULL."],
  ["archetype", utf8(), "VARCHAR", "Hue archetype, e.g. 'sultan_bulb', 'pendant_round'."],
  ["is_on", bool, "BOOLEAN", "Whether the light is on."],
  [
    "brightness",
    float64(),
    "DOUBLE",
    "Brightness in percent (0–100), the level the light has or will return to when on; an off light can report 0. NULL for on/off-only lights.",
  ],
  ["color_mode", utf8(), "VARCHAR", "'color_temperature', 'xy', or NULL for white-only/dimmable lights."],
  ["color_temperature_kelvin", int32, "INTEGER", "Colour temperature in Kelvin when in color_temperature mode."],
  ["color_x", float64(), "DOUBLE", "CIE 1931 x chromaticity coordinate of the current colour, 0–1 (unitless)."],
  ["color_y", float64(), "DOUBLE", "CIE 1931 y chromaticity coordinate of the current colour, 0–1 (unitless)."],
  ["color_hex", utf8(), "VARCHAR", "Approximate current colour as '#rrggbb' (full brightness)."],
  ["reachable", bool, "BOOLEAN", "Whether the bridge can currently reach the light over Zigbee."],
  ["product_name", utf8(), "VARCHAR", "Product name, e.g. 'Hue color lamp'."],
  ["model_id", utf8(), "VARCHAR", "Hardware model id, e.g. 'LCA001'."],
  ["device_id", utf8(), "VARCHAR", "Id of the physical device that owns the light."],
]);

/**
 * A light's rowid: FNV-1a (64-bit) of its CLIP v2 id, masked to 62 bits so it
 * is a positive BIGINT. Deterministic, so the same light has the same rowid in
 * every scan, worker process and session, with nothing stored. `lightRows`
 * refuses a (astronomically unlikely) collision rather than mixing lights up.
 */
export function lightRowId(id: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(id)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h & 0x3fffffffffffffffn;
}

export function lightRows(lights: HueLight[], devices: HueDevice[], groups: HueGroup[], zigbee: HueZigbee[]): Columns {
  const deviceById = byId(devices);
  const rooms = roomByDevice(groups);
  const reachable = reachableByDevice(zigbee);
  const sorted = [...lights].sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""));
  const cols: Columns = Object.fromEntries([...LIGHTS.names, "rowid"].map((n) => [n, []]));
  const seen = new Map<bigint, string>();
  for (const l of sorted) {
    const rowid = lightRowId(l.id);
    const clash = seen.get(rowid);
    if (clash) throw new Error(`lights ${clash} and ${l.id} hash to the same rowid; please report this`);
    seen.set(rowid, l.id);
    cols.rowid?.push(rowid);
    const device = deviceById.get(l.owner.rid);
    const mirek = l.color_temperature?.mirek ?? null;
    const xy = l.color?.xy;
    const mode = mirek != null ? "color_temperature" : xy ? "xy" : null;
    const kelvin = mirek != null ? mirekToKelvin(mirek) : null;
    const push = (k: string, v: unknown) => cols[k]?.push(v ?? null);
    push("light_id", l.id);
    push("name", l.metadata?.name);
    push("room", rooms.get(l.owner.rid)?.metadata?.name);
    push("archetype", l.metadata?.archetype);
    push("is_on", l.on?.on);
    push("brightness", l.dimming?.brightness);
    push("color_mode", mode);
    push("color_temperature_kelvin", kelvin);
    push("color_x", xy?.x);
    push("color_y", xy?.y);
    push("color_hex", kelvin != null ? kelvinToHex(kelvin) : xy ? xyToHex(xy.x, xy.y) : null);
    push("reachable", reachable.get(l.owner.rid));
    push("product_name", device?.product_data?.product_name);
    push("model_id", device?.product_data?.model_id);
    push("device_id", l.owner.rid);
  }
  return cols;
}

export const lightsTable = inventoryTable({
  name: "lights",
  primaryKey: "light_id",
  notNull: ["device_id"],
  columns: LIGHTS.schema,
  rowId: true,
  scanTags: {
    "vgi.result_columns_schema": JSON.stringify([
      ...JSON.parse(LIGHTS.tag),
      { name: "rowid", type: "BIGINT", description: "Stable row id of the light (a hash of light_id)." },
    ]),
    ...objectTags({
      title: "Lights (scan with rowid)",
      category: "inventory",
      keywords: "hue, lights, scan, rowid, update",
      docLlm:
        "The table function behind `hue.main.lights`: the same rows, plus DuckDB's `rowid` when " +
        "it is selected. Query the `hue.main.lights` table instead; this function exists so DuckDB " +
        "can scan the table for UPDATE.",
      docMd: "## lights_scan()\n\nThe scan behind `hue.main.lights`; query the table instead.",
    }),
  },
  scanExamples: [
    {
      sql: "SELECT name, is_on FROM hue.main.lights_scan() WHERE room = 'Kitchen' ORDER BY name",
      description: "The kitchen's lights, read through the scan function",
    },
  ],
  description: "Every light on the Hue bridge with its room, on/off state, brightness and colour",
  load: async (params) => {
    const c = await conn(params);
    const [lights, devices, rooms, zigbee] = await Promise.all([
      getResources<HueLight>(c, "light"),
      getResources<HueDevice>(c, "device"),
      getResources<HueGroup>(c, "room"),
      getResources<HueZigbee>(c, "zigbee_connectivity"),
    ]);
    return withPendingChanges(lightRows(lights, devices, rooms, zigbee), params.initCall.bind_call);
  },
  tags: {
    ...objectTags({
      title: "Hue Lights",
      category: "inventory",
      keywords: "hue, lights, bulbs, lamps, brightness, colour, color temperature, state",
      docLlm:
        "List every light on the attached Hue bridge, one row per light, with its current state: " +
        "`light_id`, `name`, `room`, `is_on`, `brightness` (0–100), colour (`color_mode`, " +
        "`color_temperature_kelvin`, `color_x`/`color_y`, approximate `color_hex`), `reachable`, " +
        "and hardware details. Takes no arguments. The table is writable with UPDATE: WHERE " +
        "picks the lights and SET changes them. Updatable columns are `is_on`, `brightness`, " +
        "`color_temperature_kelvin`, `color_hex` ('#rrggbb' or a basic colour name) and `name` " +
        "(renames the light); RETURNING shows the rows as written. Other columns belong to the " +
        "bridge and cannot be updated. `set_light` and `set_lights` do the same through functions.",
      docMd:
        "## lights\n\nEvery light on the bridge with its current state and room. Writable: " +
        "UPDATE its `is_on`, `brightness`, `color_temperature_kelvin`, `color_hex` or `name`.",
    }),
  },
  examples: [
    {
      sql: "UPDATE hue.main.lights SET is_on = true, brightness = 40 WHERE room = 'Kitchen' RETURNING name, brightness",
      description: "Turn the kitchen's lights on at 40% and show what changed",
    },
    {
      sql: "SELECT room, count(*) AS lights, count(*) FILTER (WHERE is_on) AS lit FROM hue.main.lights GROUP BY room ORDER BY room",
      description: "How many lights are on in each room",
    },
    {
      sql: "SELECT name, room FROM hue.main.lights WHERE NOT reachable ORDER BY name",
      description: "Lights the bridge cannot reach (unplugged or switched off at the wall)",
    },
  ],
  executableExamples: [
    {
      description: "The state columns of the lights table (reads only its schema, so no bridge is needed)",
      sql:
        "SELECT column_name, column_type FROM (DESCRIBE hue.main.lights) " +
        "WHERE column_name IN ('light_id', 'is_on', 'brightness', 'color_temperature_kelvin') ORDER BY column_name",
      expected_result: [
        { column_name: "brightness", column_type: "DOUBLE" },
        { column_name: "color_temperature_kelvin", column_type: "INTEGER" },
        { column_name: "is_on", column_type: "BOOLEAN" },
        { column_name: "light_id", column_type: "VARCHAR" },
      ],
    },
  ],
});

// -------------------------------------------------------------------- rooms()

export const ROOMS = resultColumns([
  ["room_id", utf8(), "VARCHAR", "Room or zone id (CLIP v2 UUID).", false],
  ["name", utf8(), "VARCHAR", "Room or zone name; pass it to set_room."],
  ["kind", utf8(), "VARCHAR", "'room' or 'zone'."],
  ["archetype", utf8(), "VARCHAR", "Hue archetype, e.g. 'kitchen', 'living_room'."],
  ["grouped_light_id", utf8(), "VARCHAR", "Id of the grouped_light service that controls every light at once."],
  ["any_on", bool, "BOOLEAN", "Whether at least one light in the room or zone is on."],
  ["brightness", float64(), "DOUBLE", "Average brightness of the lights that are on, in percent; 0 when all are off."],
  ["light_count", int32, "INTEGER", "Number of lights in the room or zone."],
  ["light_names", list(utf8()), "VARCHAR[]", "Names of the lights, sorted."],
]);

export function roomRows(groups: HueGroup[], grouped: HueGroupedLight[], lights: HueLight[]): Columns {
  const groupedById = byId(grouped);
  const sorted = [...groups].sort(
    (a, b) => a.type.localeCompare(b.type) || (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""),
  );
  const cols: Columns = Object.fromEntries(ROOMS.names.map((n) => [n, []]));
  for (const g of sorted) {
    const glId = g.services?.find((s) => s.rtype === "grouped_light")?.rid ?? null;
    const gl = glId ? groupedById.get(glId) : undefined;
    const members = lightsInGroup(g, lights);
    cols.room_id?.push(g.id);
    cols.name?.push(g.metadata?.name ?? null);
    cols.kind?.push(g.type);
    cols.archetype?.push(g.metadata?.archetype ?? null);
    cols.grouped_light_id?.push(glId);
    cols.any_on?.push(gl?.on?.on ?? null);
    cols.brightness?.push(gl?.dimming?.brightness ?? null);
    cols.light_count?.push(members.length);
    cols.light_names?.push(members.map((l) => l.metadata?.name ?? l.id).sort());
  }
  return cols;
}

export const roomsTable = inventoryTable({
  name: "rooms",
  primaryKey: "room_id",
  notNull: ["kind", "light_count", "light_names"],
  columns: ROOMS.schema,
  description: "Rooms and zones on the Hue bridge with their lights and combined state",
  load: async (params) => {
    const c = await conn(params);
    const [rooms, zones, grouped, lights] = await Promise.all([
      getResources<HueGroup>(c, "room"),
      getResources<HueGroup>(c, "zone"),
      getResources<HueGroupedLight>(c, "grouped_light"),
      getResources<HueLight>(c, "light"),
    ]);
    return roomRows([...rooms, ...zones], grouped, lights);
  },
  tags: {
    ...objectTags({
      title: "Rooms and Zones",
      category: "inventory",
      keywords: "hue, rooms, zones, groups, grouped light, areas",
      docLlm:
        "List the rooms and zones on the attached Hue bridge, one row each: `room_id`, `name`, " +
        "`kind` ('room' or 'zone'), `archetype`, `grouped_light_id`, `any_on`, average " +
        "`brightness`, `light_count` and `light_names` (a `VARCHAR[]` list). Takes no arguments. " +
        "Pass `name` or `room_id` to `set_room` to switch a whole room at once, or to " +
        "`recall_scene(..., room := ...)` to pick a scene by room.",
      docMd: "## rooms\n\nRooms and zones, their lights, and whether any are on.",
    }),
  },
  examples: [
    {
      sql: "SELECT name, light_count, any_on FROM hue.main.rooms WHERE kind = 'room' ORDER BY light_count DESC",
      description: "Rooms with the most lights first, and whether any are on",
    },
    {
      sql: "SELECT name, unnest(light_names) AS light FROM hue.main.rooms WHERE kind = 'zone' ORDER BY name, light",
      description: "Which lights each zone contains",
    },
  ],
});

// ------------------------------------------------------------------- scenes()

export const SCENES = resultColumns([
  ["scene_id", utf8(), "VARCHAR", "Scene id (CLIP v2 UUID); pass it to recall_scene.", false],
  ["name", utf8(), "VARCHAR", "Scene name, e.g. 'Relax'."],
  ["room", utf8(), "VARCHAR", "Name of the room or zone the scene belongs to."],
  ["room_id", utf8(), "VARCHAR", "Id of the room or zone the scene belongs to."],
  ["active", bool, "BOOLEAN", "Whether the scene is currently active (static or dynamic)."],
]);

export function sceneRows(scenes: HueScene[], groups: HueGroup[]): Columns {
  const groupById = byId(groups);
  const rows = scenes.map((s) => ({
    scene_id: s.id,
    name: s.metadata?.name ?? null,
    room: (s.group && groupById.get(s.group.rid)?.metadata?.name) ?? null,
    room_id: s.group?.rid ?? null,
    active: s.status?.active ? s.status.active !== "inactive" : null,
  }));
  rows.sort((a, b) => (a.room ?? "").localeCompare(b.room ?? "") || (a.name ?? "").localeCompare(b.name ?? ""));
  return Object.fromEntries(SCENES.names.map((n) => [n, rows.map((r) => r[n as keyof typeof r])]));
}

export const scenesTable = inventoryTable({
  name: "scenes",
  primaryKey: "scene_id",
  notNull: [],
  columns: SCENES.schema,
  description: "Scenes stored on the Hue bridge, with their room and whether each is active",
  load: async (params) => {
    const c = await conn(params);
    const [scenes, rooms, zones] = await Promise.all([
      getResources<HueScene>(c, "scene"),
      getResources<HueGroup>(c, "room"),
      getResources<HueGroup>(c, "zone"),
    ]);
    return sceneRows(scenes, [...rooms, ...zones]);
  },
  tags: {
    ...objectTags({
      title: "Hue Scenes",
      category: "inventory",
      keywords: "hue, scenes, presets, moods, relax, concentrate",
      docLlm:
        "List the scenes stored on the attached Hue bridge: `scene_id`, `name`, the `room` " +
        "(room or zone name) and `room_id` it belongs to, and whether it is `active`. Takes no " +
        "arguments. Scene names repeat across rooms (every room has a 'Relax'), so recall one " +
        "with `recall_scene(scene_id)` or `recall_scene(name, room := 'Kitchen')`.",
      docMd: "## scenes\n\nScenes on the bridge and the room each belongs to.",
    }),
  },
  examples: [
    {
      sql: "SELECT room, list(name ORDER BY name) AS scenes FROM hue.main.scenes GROUP BY room ORDER BY room",
      description: "The scenes available in each room",
    },
    {
      sql: "SELECT room, name FROM hue.main.scenes WHERE active ORDER BY room",
      description: "Which scene is active in each room",
    },
  ],
});

// ------------------------------------------------------------------ sensors()

export const SENSOR_KINDS = ["motion", "temperature", "light_level", "contact", "device_power"] as const;

export const SENSORS = resultColumns([
  ["sensor_id", utf8(), "VARCHAR", "Sensor service id (CLIP v2 UUID).", false],
  ["kind", utf8(), "VARCHAR", "'motion', 'temperature', 'light_level', 'contact' or 'device_power' (battery)."],
  ["device_id", utf8(), "VARCHAR", "Id of the physical device; one device can carry several sensors."],
  ["device_name", utf8(), "VARCHAR", "Name of the device, e.g. 'Hallway sensor'."],
  ["room", utf8(), "VARCHAR", "Name of the room the device is in, or NULL."],
  [
    "enabled",
    bool,
    "BOOLEAN",
    "Whether the sensor is enabled (NULL for battery readings). A disabled sensor's reading columns and last_changed are NULL, since the bridge only holds a stale value.",
  ],
  ["motion", bool, "BOOLEAN", "motion: whether motion is currently detected."],
  ["temperature_c", float64(), "DOUBLE", "temperature: degrees Celsius."],
  ["light_level_lux", float64(), "DOUBLE", "light_level: ambient light in lux."],
  ["contact", bool, "BOOLEAN", "contact: true when closed (in contact), false when open."],
  ["battery_percent", int32, "INTEGER", "device_power: battery level in percent."],
  ["battery_state", utf8(), "VARCHAR", "device_power: 'normal', 'low' or 'critical'."],
  ["reachable", bool, "BOOLEAN", "Whether the bridge can currently reach the device over Zigbee."],
  ["last_changed", timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", "When the reading last changed."],
]);

export function sensorRows(
  sensors: HueSensor[],
  devices: HueDevice[],
  groups: HueGroup[],
  zigbee: HueZigbee[],
): Columns {
  const deviceById = byId(devices);
  const rooms = roomByDevice(groups);
  const reachable = reachableByDevice(zigbee);
  // timestamp[us] columns take epoch microseconds as a bigint.
  const micros = (s?: string) => {
    const ms = s ? Date.parse(s) : Number.NaN;
    return Number.isNaN(ms) ? null : BigInt(ms) * 1000n;
  };
  const rows = sensors.map((s) => {
    const device = deviceById.get(s.owner.rid);
    // A disabled sensor keeps reporting its last value, which can be days old:
    // show no reading rather than a stale one. (Battery rows have no `enabled`.)
    const live = s.enabled !== false;
    const level = live ? (s.light?.light_level_report?.light_level ?? s.light?.light_level) : undefined;
    const contactState = live ? s.contact_report?.state : undefined;
    return {
      sensor_id: s.id,
      kind: s.type,
      device_id: s.owner.rid,
      device_name: device?.metadata?.name ?? null,
      room: rooms.get(s.owner.rid)?.metadata?.name ?? null,
      enabled: s.enabled ?? null,
      motion: live && s.motion ? (s.motion.motion_report?.motion ?? s.motion.motion ?? null) : null,
      temperature_c:
        live && s.temperature
          ? (s.temperature.temperature_report?.temperature ?? s.temperature.temperature ?? null)
          : null,
      light_level_lux: level != null ? lightLevelToLux(level) : null,
      contact: contactState ? contactState === "contact" : null,
      battery_percent: s.power_state?.battery_level ?? null,
      battery_state: s.power_state?.battery_state ?? null,
      reachable: reachable.get(s.owner.rid) ?? null,
      last_changed: micros(
        !live
          ? undefined
          : (s.motion?.motion_report?.changed ??
              s.temperature?.temperature_report?.changed ??
              s.light?.light_level_report?.changed ??
              s.contact_report?.changed),
      ),
    };
  });
  rows.sort((a, b) => (a.device_name ?? "").localeCompare(b.device_name ?? "") || a.kind.localeCompare(b.kind));
  return Object.fromEntries(SENSORS.names.map((n) => [n, rows.map((r) => r[n as keyof typeof r])]));
}

export const sensorsTable = inventoryTable({
  name: "sensors",
  primaryKey: "sensor_id",
  notNull: ["kind", "device_id"],
  columns: SENSORS.schema,
  description: "Motion, temperature, light-level, contact and battery readings from Hue sensors",
  load: async (params) => {
    const c = await conn(params);
    const [devices, rooms, zigbee, ...byKind] = await Promise.all([
      getResources<HueDevice>(c, "device"),
      getResources<HueGroup>(c, "room"),
      getResources<HueZigbee>(c, "zigbee_connectivity"),
      ...SENSOR_KINDS.map((k) => getResources<HueSensor>(c, k)),
    ]);
    return sensorRows(byKind.flat(), devices, rooms, zigbee);
  },
  tags: {
    ...objectTags({
      title: "Hue Sensor Readings",
      category: "sensors",
      keywords: "hue, sensors, motion, temperature, light level, lux, contact, door, battery",
      docLlm:
        "Read every sensor on the attached Hue bridge, one row per sensor service. `kind` says " +
        "which reading column is filled: 'motion' → `motion` (`BOOLEAN`), 'temperature' → " +
        "`temperature_c`, 'light_level' → `light_level_lux`, 'contact' → `contact` (true = " +
        "closed), 'device_power' → `battery_percent` and `battery_state`. Every row also has " +
        "`sensor_id`, `device_id`, `device_name`, `room`, `enabled`, `reachable` and " +
        "`last_changed` (`TIMESTAMPTZ`). A Hue motion sensor appears as four rows (motion, " +
        "temperature, light_level, device_power) sharing one `device_id`. Takes no arguments.",
      docMd:
        "## sensors\n\nCurrent readings from motion, temperature, light-level, contact and " +
        "battery sensors, one row per reading.",
    }),
  },
  examples: [
    {
      sql: "SELECT room, round(avg(temperature_c), 1) AS avg_c FROM hue.main.sensors WHERE kind = 'temperature' GROUP BY room ORDER BY room",
      description: "Average temperature per room",
    },
    {
      sql: "SELECT device_name, battery_percent FROM hue.main.sensors WHERE kind = 'device_power' AND battery_percent < 20 ORDER BY battery_percent",
      description: "Sensors whose batteries need replacing",
    },
  ],
});
