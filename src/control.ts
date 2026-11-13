/**
 * Control functions: set_light(), set_room(), recall_scene() and the bulk
 * table in-out set_lights().
 *
 * These change the state of real lights, so they are table functions (which
 * run asynchronously and see the ATTACH options) marked VOLATILE, and the
 * change is sent only when the query executes, never at bind. Each returns
 * one row per resource it changed, with the request body that was sent.
 *
 * The state arguments are all named and optional (NULL = leave unchanged):
 *   power := true|false, brightness := 0–100 (0 turns off), kelvin := 2000–6500,
 *   color := '#rrggbb' | 'red' | ..., transition_ms := fade time.
 * `on` is a SQL keyword, so the on/off argument is called `power`.
 */

import {
  batchFromColumns,
  bool,
  defineTableFunction,
  defineTableInOutFunction,
  FunctionStability,
  float64,
  int64,
  list,
  utf8,
  type VgiDataType,
} from "@query-farm/vgi";
import { connectionFor } from "./attach.ts";
import { immediate, type Sender, senderFor } from "./dispatch.ts";
import {
  type BridgeConnection,
  buildStateBody,
  getResources,
  gradientBody,
  HueError,
  type HueGroup,
  type HueLight,
  type HueScene,
  type HueZigbee,
  type LightChange,
  lightsInGroup,
  parseColor,
  reachableByDevice,
  rgbToXy,
  type Xy,
} from "./hue.ts";
import { objectTags, resultColumns } from "./meta.ts";

// ------------------------------------------------------------------ arguments

interface StateArgs {
  power: boolean | null;
  brightness: number | null;
  kelvin: bigint | null;
  color: string | null;
  transition_ms: bigint | null;
}

const STATE_ARG_TYPES: Record<keyof StateArgs, VgiDataType> = {
  power: bool,
  brightness: float64(),
  kelvin: int64(),
  color: utf8(),
  transition_ms: int64(),
};
const STATE_DEFAULTS = { power: null, brightness: null, kelvin: null, color: null, transition_ms: null };
const STATE_DOCS: Record<keyof StateArgs, string> = {
  power: "Named, optional: true turns on, false turns off; NULL leaves it unchanged.",
  brightness: "Named, optional: brightness in percent, 0–100. Above 0 also turns the light on; 0 turns it off.",
  kelvin: "Named, optional: white colour temperature in Kelvin, 2000 (warm) to 6500 (cool).",
  color:
    "Named, optional: colour as '#rrggbb' or a name (red, orange, yellow, green, cyan, blue, purple, magenta, pink, white).",
  transition_ms: "Named, optional: fade duration in milliseconds.",
};
const STATE_CONSTRAINTS = {
  brightness: { ge: 0, le: 100 },
  kelvin: { ge: 2000, le: 6500 },
  transition_ms: { ge: 0, le: 3_600_000 },
};

function changeFrom(args: StateArgs): LightChange {
  return {
    on: args.power,
    brightness: args.brightness,
    kelvin: args.kelvin == null ? null : Number(args.kelvin),
    color: args.color,
    transition_ms: args.transition_ms == null ? null : Number(args.transition_ms),
  };
}

// --------------------------------------------------------------------- result

export const RESULT = resultColumns([
  ["target_type", utf8(), "VARCHAR", "What was changed: 'light', 'room', 'zone' or 'scene'.", false],
  ["target_id", utf8(), "VARCHAR", "Id of the light, room/zone, or scene.", false],
  ["name", utf8(), "VARCHAR", "Name of the light, room/zone, or scene."],
  ["ok", bool, "BOOLEAN", "Whether the bridge accepted the change.", false],
  ["error", utf8(), "VARCHAR", "Why the change failed, or NULL."],
  ["request", utf8(), "VARCHAR", "JSON body sent to the bridge."],
  [
    "settled",
    bool,
    "BOOLEAN",
    "set_room with wait_ms: whether every reachable light reported the new state within wait_ms; NULL when not waited.",
  ],
]);

interface ResultRow {
  target_type: string;
  target_id: string;
  name: string | null;
  ok: boolean;
  error: string | null;
  request: string | null;
  settled: boolean | null;
}

const toColumns = (rows: ResultRow[]) =>
  Object.fromEntries(RESULT.names.map((n) => [n, rows.map((r) => r[n as keyof ResultRow])]));

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Match by exact id first, then case-insensitive name. */
export function matchByIdOrName<T extends { id: string; metadata?: { name?: string } }>(
  items: T[],
  target: string,
): T[] {
  const byId = items.filter((i) => i.id === target);
  if (byId.length) return byId;
  return items.filter((i) => norm(i.metadata?.name) === norm(target));
}

const known = (items: { metadata?: { name?: string } }[]) =>
  items
    .map((i) => i.metadata?.name)
    .filter(Boolean)
    .sort()
    .slice(0, 20)
    .map((n) => `'${n}'`)
    .join(", ");

/** One-shot table function state: has the command been sent yet? */
interface DoneState {
  done: boolean;
}

// ----------------------------------------------------------------- set_light

interface SetLightArgs extends StateArgs {
  light: string;
}

export async function setLight(
  conn: BridgeConnection,
  target: string,
  change: LightChange,
  send: Sender = immediate(conn),
): Promise<ResultRow[]> {
  const body = buildStateBody(change);
  const lights = await getResources<HueLight>(conn, "light");
  const matches = matchByIdOrName(lights, target);
  if (!matches.length) throw new HueError(`no light with id or name '${target}'. Lights: ${known(lights)}`);
  const rows: ResultRow[] = [];
  for (const light of matches) {
    await send([{ kind: "light", target: light.id, body }]);
    rows.push({
      target_type: "light",
      target_id: light.id,
      name: light.metadata?.name ?? null,
      ok: true,
      error: null,
      request: JSON.stringify(body),
      settled: null,
    });
  }
  return rows;
}

export const setLightFn = defineTableFunction<SetLightArgs, DoneState>({
  name: "set_light",
  description: "Turn one light on or off, or set its brightness, colour temperature or colour",
  args: { light: utf8(), ...STATE_ARG_TYPES },
  argDefaults: STATE_DEFAULTS,
  argDocs: { light: "Light id or name (case-insensitive); every light with that name is changed.", ...STATE_DOCS },
  argConstraints: STATE_CONSTRAINTS,
  stability: FunctionStability.VOLATILE,
  onBind: (params) => {
    buildStateBody(changeFrom(params.args)); // reject bad arguments before anything runs
    return { outputSchema: RESULT.schema };
  },
  initialState: () => ({ done: false }),
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    const conn = await connectionFor(params.initCall.bind_call);
    const rows = await setLight(
      conn,
      params.args.light,
      changeFrom(params.args),
      senderFor(params.initCall.bind_call, conn),
    );
    out.emit(batchFromColumns(toColumns(rows), params.outputSchema));
    state.done = true;
  },
  tags: {
    ...objectTags({
      title: "Set Light",
      category: "control",
      keywords: "hue, turn on, turn off, switch, dim, brightness, colour, color, kelvin, light control",
      docLlm:
        "Change one light on the attached Hue bridge and return what was sent. The positional " +
        "argument `light` is a light id or name from `lights` (names match case-insensitively). " +
        "All state arguments are named and optional; give at least one: `power := true|false` " +
        "(on/off; `on` is a SQL keyword), `brightness := 0..100` (above 0 implies on, 0 turns off), " +
        "`kelvin := 2000..6500` (white temperature) or `color := '#rrggbb'` / a basic colour name " +
        "(not both), and `transition_ms` (fade time). Returns one row per light changed: " +
        "`target_type`, `target_id`, `name`, `ok`, `error`, `request`. This changes real lights: " +
        "call it only when the user asks for it.",
      docMd:
        "## set_light(light, power :=, brightness :=, kelvin :=, color :=, transition_ms :=)\n\n" +
        "Change one light. Every state argument is optional and named.",
    }),
    "vgi.result_columns_schema": RESULT.tag,
  },
  examples: [
    {
      sql: "SELECT name, ok FROM hue.main.set_light('Desk lamp', brightness := 40, kelvin := 2700)",
      description: "Dim the desk lamp to 40% warm white",
    },
    {
      sql: "SELECT name, ok FROM hue.main.set_light('Desk lamp', power := false)",
      description: "Turn the desk lamp off",
    },
  ],
});

// -------------------------------------------------------------- set_gradient

interface SetGradientArgs {
  light: string;
  colors: unknown;
  mode: string | null;
}

export const DEFAULT_GRADIENT_MODE = "interpolated_palette";
/** The CLIP v2 gradient modes; each light lists the ones it supports in gradient.mode_values. */
export const GRADIENT_MODES = [
  "interpolated_palette",
  "interpolated_palette_mirrored",
  "random_pixelated",
  "segmented_palette",
] as const;

/** The colours of a set_gradient call as xy points; refused when empty, NULL or not colours. */
export function gradientColors(colors: unknown): Xy[] {
  const items = colors == null ? [] : (JSON.parse(JSON.stringify(colors)) as unknown[]);
  if (!items.length) throw new HueError("set_gradient needs at least two colours");
  return items.map((c) => {
    if (c == null) throw new HueError("gradient points must not be NULL");
    return rgbToXy(parseColor(String(c)));
  });
}

export async function setGradient(
  conn: BridgeConnection,
  target: string,
  points: Xy[],
  mode: string = DEFAULT_GRADIENT_MODE,
  send: Sender = immediate(conn),
): Promise<ResultRow[]> {
  const lights = await getResources<HueLight>(conn, "light");
  const matches = matchByIdOrName(lights, target);
  if (!matches.length) throw new HueError(`no light with id or name '${target}'. Lights: ${known(lights)}`);
  // Validate every match before sending anything.
  for (const light of matches) {
    const name = light.metadata?.name ?? light.id;
    if (!light.gradient) throw new HueError(`light '${name}' does not support gradients`);
    const max = light.gradient.points_capable ?? 0;
    if (points.length < 2 || points.length > max) {
      throw new HueError(`light '${name}' takes 2–${max} gradient points, got ${points.length}`);
    }
    const modes = light.gradient.mode_values;
    if (modes && !modes.includes(mode)) {
      throw new HueError(`invalid gradient_mode '${mode}' for light '${name}'; allowed: ${modes.join(", ")}`);
    }
  }
  const body = { gradient: gradientBody(points, mode) };
  const rows: ResultRow[] = [];
  for (const light of matches) {
    await send([{ kind: "light", target: light.id, body }]);
    rows.push({
      target_type: "light",
      target_id: light.id,
      name: light.metadata?.name ?? null,
      ok: true,
      error: null,
      request: JSON.stringify(body),
      settled: null,
    });
  }
  return rows;
}

export const setGradientFn = defineTableFunction<SetGradientArgs, DoneState>({
  name: "set_gradient",
  description: "Set the gradient of a gradient light (lightstrip, Play gradient) from a list of colours",
  args: { light: utf8(), colors: list(utf8()), mode: utf8() },
  argDefaults: { mode: DEFAULT_GRADIENT_MODE },
  argDocs: {
    light: "Light id or name (case-insensitive); every light with that name is changed.",
    colors:
      "The gradient points in order, each a '#rrggbb' colour or a basic colour name; from 2 up to the light's gradient_points_capable.",
    mode: "Named, optional: how the points are spread over the light; one the light lists as supported.",
  },
  argConstraints: { mode: { choices: [...GRADIENT_MODES] } },
  stability: FunctionStability.VOLATILE,
  onBind: (params) => {
    gradientColors(params.args.colors); // reject bad colours before anything runs
    return { outputSchema: RESULT.schema };
  },
  initialState: () => ({ done: false }),
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    const conn = await connectionFor(params.initCall.bind_call);
    const rows = await setGradient(
      conn,
      params.args.light,
      gradientColors(params.args.colors),
      params.args.mode ?? DEFAULT_GRADIENT_MODE,
      senderFor(params.initCall.bind_call, conn),
    );
    out.emit(batchFromColumns(toColumns(rows), params.outputSchema));
    state.done = true;
  },
  tags: {
    ...objectTags({
      title: "Set Gradient",
      category: "control",
      keywords: "hue, gradient, lightstrip, play gradient, multicolour, palette, segments, light control",
      docLlm:
        "Set the gradient of a gradient-capable light (a Hue gradient lightstrip or Play gradient " +
        "bar: `gradient_points_capable` is not NULL in `lights`) and return what was sent. " +
        "Arguments: `light` (positional) is a light id or case-insensitive name from `lights`; " +
        "`colors` (positional) is a `VARCHAR[]` of '#rrggbb' colours or basic colour names, the " +
        "gradient points in order, 2 up to the light's `gradient_points_capable`; `mode := ...` " +
        "(named, optional, default 'interpolated_palette') is one of the light's gradient modes: " +
        "'interpolated_palette', 'interpolated_palette_mirrored', 'random_pixelated', " +
        "'segmented_palette'. A light without a gradient, fewer than 2 or too many colours or an unknown mode is " +
        "an error and nothing is sent. Returns one row per light changed: `target_type` ('light'), " +
        "`target_id`, `name`, `ok`, `error`, `request`, `settled`. Updating the `gradient_hex` " +
        "column of `lights` does the same. Changes real lights: call it only when asked.",
      docMd:
        "## set_gradient(light, colors, mode := 'interpolated_palette')\n\n" +
        "Set a gradient light's points from a list of '#rrggbb' colours.",
    }),
    "vgi.result_columns_schema": RESULT.tag,
  },
  examples: [
    {
      sql: "SELECT name, ok FROM hue.main.set_gradient('Hallway strip', ['#ff0000', '#ff8000', '#0000ff'])",
      description: "A red-orange-blue gradient on the hallway lightstrip",
    },
    {
      sql: "SELECT name, request FROM hue.main.set_gradient('Hallway strip', ['#00ff00', '#0000ff'], mode := 'segmented_palette')",
      description: "Two solid segments, green and blue",
    },
  ],
});

// ------------------------------------------------------------------ set_room

interface SetRoomArgs extends StateArgs {
  room: string;
  wait_ms: bigint | null;
}

/**
 * Whether `light` reports the state `body` asked for. On/off and brightness
 * must match; colour and white temperature only need the matching colour mode,
 * because a bulb clamps the requested colour to its own gamut and range. A
 * capability the light lacks is not waited for, nor is anything on a light
 * asked to turn off.
 */
export function lightReflects(light: HueLight, body: Record<string, unknown>): boolean {
  const want = body as {
    on?: { on: boolean };
    dimming?: { brightness: number };
    color_temperature?: unknown;
    color?: unknown;
  };
  if (want.on && light.on && light.on.on !== want.on.on) return false;
  if (want.on?.on === false) return true;
  if (want.dimming && light.dimming && Math.abs(light.dimming.brightness - want.dimming.brightness) > 1.5) return false;
  if (want.color_temperature && light.color_temperature && light.color_temperature.mirek == null) return false;
  if (want.color && light.color && light.color_temperature?.mirek != null) return false;
  return true;
}

export const SETTLE_POLL_MS = 250;
export const MAX_WAIT_MS = 30_000;

/**
 * Poll until every reachable light in `group` reflects `body`, or `waitMs`
 * passes. Room commands reach bulbs one by one over Zigbee, so a read straight
 * after the PUT can still show the old state for a second or two.
 */
export async function waitForGroup(
  conn: BridgeConnection,
  group: HueGroup,
  body: Record<string, unknown>,
  waitMs: number,
  pollMs = SETTLE_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  const zigbee = await getResources<HueZigbee>(conn, "zigbee_connectivity");
  const reachable = reachableByDevice(zigbee);
  for (;;) {
    const lights = await getResources<HueLight>(conn, "light");
    const members = lightsInGroup(group, lights).filter((l) => reachable.get(l.owner.rid) !== false);
    if (members.every((l) => lightReflects(l, body))) return true;
    if (Date.now() + pollMs > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function setRoom(
  conn: BridgeConnection,
  target: string,
  change: LightChange,
  waitMs: number | null = null,
  send: Sender = immediate(conn),
): Promise<ResultRow[]> {
  const body = buildStateBody(change);
  const [rooms, zones] = await Promise.all([
    getResources<HueGroup>(conn, "room"),
    getResources<HueGroup>(conn, "zone"),
  ]);
  const groups = [...rooms, ...zones];
  const matches = matchByIdOrName(groups, target);
  if (!matches.length)
    throw new HueError(`no room or zone with id or name '${target}'. Rooms and zones: ${known(groups)}`);
  if (matches.length > 1) {
    throw new HueError(`'${target}' names both a room and a zone; pass the room_id from rooms instead`);
  }
  const group = matches[0] as HueGroup;
  const glId = group.services?.find((s) => s.rtype === "grouped_light")?.rid;
  if (!glId) throw new HueError(`${group.type} '${group.metadata?.name}' has no grouped_light service`);
  const how = await send([{ kind: "grouped_light", target: glId, body }]);
  // A staged change reaches the bulbs only at COMMIT: nothing to wait for yet.
  const settled = waitMs == null || how === "staged" ? null : await waitForGroup(conn, group, body, waitMs);
  return [
    {
      target_type: group.type,
      target_id: group.id,
      name: group.metadata?.name ?? null,
      ok: true,
      error: null,
      request: JSON.stringify(body),
      settled,
    },
  ];
}

export const setRoomFn = defineTableFunction<SetRoomArgs, DoneState>({
  name: "set_room",
  description: "Change every light in a room or zone at once: on/off, brightness, colour temperature or colour",
  args: { room: utf8(), ...STATE_ARG_TYPES, wait_ms: int64() },
  argDefaults: { ...STATE_DEFAULTS, wait_ms: null },
  argDocs: {
    room: "Room or zone id or name (case-insensitive), as listed by rooms.",
    ...STATE_DOCS,
    wait_ms:
      "Named, optional: wait up to this many milliseconds (max 30000) until every reachable light " +
      "reports the new state, and say whether it did in the `settled` column. NULL returns at once.",
  },
  argConstraints: { ...STATE_CONSTRAINTS, wait_ms: { ge: 0, le: MAX_WAIT_MS } },
  stability: FunctionStability.VOLATILE,
  onBind: (params) => {
    buildStateBody(changeFrom(params.args));
    return { outputSchema: RESULT.schema };
  },
  initialState: () => ({ done: false }),
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    const conn = await connectionFor(params.initCall.bind_call);
    const rows = await setRoom(
      conn,
      params.args.room,
      changeFrom(params.args),
      params.args.wait_ms == null ? null : Number(params.args.wait_ms),
      senderFor(params.initCall.bind_call, conn),
    );
    out.emit(batchFromColumns(toColumns(rows), params.outputSchema));
    state.done = true;
  },
  tags: {
    ...objectTags({
      title: "Set Room",
      category: "control",
      keywords: "hue, room, zone, group, all lights, turn off room, dim room, light control",
      docLlm:
        "Change every light in one room or zone of the attached Hue bridge with a single command " +
        "(its grouped_light). The positional argument `room` is a room/zone id or name from " +
        "`rooms`. Named optional state arguments, at least one required: `power := true|false`, " +
        "`brightness := 0..100`, `kelvin := 2000..6500` or `color := '#rrggbb'`, `transition_ms`. " +
        "Returns one row (`target_type` 'room' or 'zone', `target_id`, `name`, `ok`, `error`, " +
        "`request`, `settled`). The bridge relays a room command to each bulb over Zigbee, so the " +
        "lights table can show the old state for a second or two afterwards; pass `wait_ms := 3000` " +
        "to wait until every reachable light reports the change (`settled` says whether it did). " +
        "Changes real lights: call it only when the user asks for it.",
      docMd:
        "## set_room(room, power :=, brightness :=, kelvin :=, color :=, transition_ms :=, wait_ms :=)\n\n" +
        "Change every light in a room or zone at once. The bulbs pick the change up over a second " +
        "or two; `wait_ms` waits for them and reports it in `settled`.",
    }),
    "vgi.result_columns_schema": RESULT.tag,
  },
  examples: [
    {
      sql: "SELECT name, ok FROM hue.main.set_room('Kitchen', power := false)",
      description: "Turn off every light in the kitchen",
    },
    {
      sql: "SELECT name, ok FROM hue.main.set_room('Living room', brightness := 30, color := 'orange', transition_ms := 2000)",
      description: "Fade the living room to dim orange over two seconds",
    },
  ],
});

// -------------------------------------------------------------- recall_scene

interface RecallSceneArgs {
  scene: string;
  room: string | null;
}

export async function recallScene(
  conn: BridgeConnection,
  target: string,
  room: string | null,
  send: Sender = immediate(conn),
): Promise<ResultRow[]> {
  const [scenes, rooms, zones] = await Promise.all([
    getResources<HueScene>(conn, "scene"),
    getResources<HueGroup>(conn, "room"),
    getResources<HueGroup>(conn, "zone"),
  ]);
  let matches = matchByIdOrName(scenes, target);
  if (room != null) {
    const groupIds = new Set(matchByIdOrName([...rooms, ...zones], room).map((g) => g.id));
    if (!groupIds.size) throw new HueError(`no room or zone with id or name '${room}'`);
    matches = matches.filter((s) => s.group && groupIds.has(s.group.rid));
  }
  if (!matches.length) {
    throw new HueError(`no scene '${target}'${room != null ? ` in '${room}'` : ""}. Scenes: ${known(scenes)}`);
  }
  if (matches.length > 1) {
    throw new HueError(`scene name '${target}' exists in several rooms; add room := '...' or pass the scene_id`);
  }
  const scene = matches[0] as HueScene;
  const body = { recall: { action: "active" } };
  await send([{ kind: "scene", target: scene.id, body }]);
  return [
    {
      target_type: "scene",
      target_id: scene.id,
      name: scene.metadata?.name ?? null,
      ok: true,
      error: null,
      request: JSON.stringify(body),
      settled: null,
    },
  ];
}

export const recallSceneFn = defineTableFunction<RecallSceneArgs, DoneState>({
  name: "recall_scene",
  description: "Activate a Hue scene by id, or by name optionally narrowed to a room",
  args: { scene: utf8(), room: utf8() },
  argDefaults: { room: null },
  argDocs: {
    scene: "Scene id, or scene name (case-insensitive), as listed by scenes.",
    room: "Named, optional: room or zone name or id, to pick between scenes that share a name.",
  },
  stability: FunctionStability.VOLATILE,
  onBind: () => ({ outputSchema: RESULT.schema }),
  initialState: () => ({ done: false }),
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    const conn = await connectionFor(params.initCall.bind_call);
    const rows = await recallScene(
      conn,
      params.args.scene,
      params.args.room,
      senderFor(params.initCall.bind_call, conn),
    );
    out.emit(batchFromColumns(toColumns(rows), params.outputSchema));
    state.done = true;
  },
  tags: {
    ...objectTags({
      title: "Recall Scene",
      category: "control",
      keywords: "hue, scene, activate scene, preset, mood, relax, concentrate",
      docLlm:
        "Activate a scene on the attached Hue bridge. `scene` is a scene id or name from " +
        "`scenes`. Scene names repeat across rooms, so pass the named argument " +
        "`room := 'Kitchen'` (room/zone name or id) when the name is ambiguous; an ambiguous " +
        "name without `room` is an error. Returns one row (`target_type` 'scene', `target_id`, " +
        "`name`, `ok`, `error`, `request`). Changes real lights: call it only when asked.",
      docMd: "## recall_scene(scene, room := NULL)\n\nActivate a scene.",
    }),
    "vgi.result_columns_schema": RESULT.tag,
  },
  examples: [
    {
      sql: "SELECT name, ok FROM hue.main.recall_scene('Relax', room := 'Living room')",
      description: "Activate the living room's Relax scene",
    },
  ],
});

// ----------------------------------------------------------------- set_lights

export const setLightsFn = defineTableInOutFunction<StateArgs, null>({
  name: "set_lights",
  description: "Apply one change to every light listed by a query (its light_id column)",
  namedArgs: STATE_ARG_TYPES,
  argDefaults: STATE_DEFAULTS,
  argDocs: {
    ...STATE_DOCS,
    data:
      "Input query: one row per light to change, with a `light_id` column (from hue.main.lights) " +
      "and optionally a `name` column that is echoed back.",
  },
  argConstraints: STATE_CONSTRAINTS,
  stability: FunctionStability.VOLATILE,
  onBind: (params) => {
    const input = params.bindCall.input_schema;
    if (!input?.fields.some((f) => f.name === "light_id")) {
      throw new HueError(
        "set_lights needs an input query with a light_id column, e.g. (SELECT light_id FROM hue.main.lights)",
      );
    }
    buildStateBody(changeFrom(params.args));
    return { outputSchema: RESULT.schema };
  },
  process: async (params, _state, batch, out) => {
    const conn = await connectionFor(params.initCall.bind_call);
    const send = senderFor(params.initCall.bind_call, conn);
    const body = buildStateBody(changeFrom(params.args));
    const ids = batch.getChild("light_id");
    const nameCol = batch.getChild("name");
    const rows: ResultRow[] = [];
    for (let i = 0; i < batch.numRows; i++) {
      const id = ids?.get(i) as string | null;
      const name = (nameCol?.get(i) as string | null | undefined) ?? null;
      if (id == null) {
        rows.push({
          target_type: "light",
          target_id: "",
          name,
          ok: false,
          error: "light_id is NULL",
          request: null,
          settled: null,
        });
        continue;
      }
      try {
        await send([{ kind: "light", target: id, body }]);
        rows.push({
          target_type: "light",
          target_id: id,
          name,
          ok: true,
          error: null,
          request: JSON.stringify(body),
          settled: null,
        });
      } catch (err) {
        rows.push({
          target_type: "light",
          target_id: id,
          name,
          ok: false,
          error: (err as Error).message,
          request: JSON.stringify(body),
          settled: null,
        });
      }
    }
    out.emit(batchFromColumns(toColumns(rows), params.outputSchema));
  },
  tags: {
    ...objectTags({
      title: "Set Lights (bulk)",
      category: "control",
      keywords: "hue, bulk, many lights, all lights, turn off everything, filter lights, light control",
      docLlm:
        "Apply the same change to every light a subquery returns. The input query must have a " +
        "`light_id` column (from `lights`); an optional `name` column is echoed back. Named " +
        "optional state arguments, at least one required: `power := true|false`, " +
        "`brightness := 0..100`, `kelvin := 2000..6500` or `color := '#rrggbb'`, " +
        "`transition_ms`. Commands are paced at about ten per second, as Hue requires. Returns " +
        "one row per input row (`target_type`, `target_id`, `name`, `ok`, `error`, `request`); " +
        "a failure on one light is reported in its row rather than aborting the rest. Changes " +
        "real lights: call it only when asked.",
      docMd:
        "## set_lights((query), power :=, brightness :=, kelvin :=, color :=, transition_ms :=)\n\n" +
        "Change every light a query selects; the query needs a `light_id` column.",
    }),
    "vgi.result_columns_schema": RESULT.tag,
  },
  examples: [
    {
      sql:
        "SELECT name, ok, error FROM hue.main.set_lights((SELECT light_id, name FROM hue.main.lights " +
        "WHERE is_on AND room <> 'Bedroom'), power := false)",
      description: "Turn off every light that is on, except in the bedroom",
    },
    {
      sql:
        "SELECT count(*) FILTER (WHERE ok) AS changed FROM hue.main.set_lights((SELECT light_id FROM hue.main.lights " +
        "WHERE color_mode IS NOT NULL), kelvin := 2700, transition_ms := 1000)",
      description: "Fade every colour-capable light to warm white",
    },
  ],
});
