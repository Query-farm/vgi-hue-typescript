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
  utf8,
  type VgiDataType,
} from "@query-farm/vgi";
import { connectionFor, decodeAttachOptions } from "./attach.ts";
import {
  type BridgeConnection,
  buildStateBody,
  getResources,
  HueError,
  type HueGroup,
  type HueLight,
  type HueScene,
  hueRequest,
  type LightChange,
  pace,
  resolveConnection,
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
]);

interface ResultRow {
  target_type: string;
  target_id: string;
  name: string | null;
  ok: boolean;
  error: string | null;
  request: string | null;
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

export async function setLight(conn: BridgeConnection, target: string, change: LightChange): Promise<ResultRow[]> {
  const body = buildStateBody(change);
  const lights = await getResources<HueLight>(conn, "light");
  const matches = matchByIdOrName(lights, target);
  if (!matches.length) throw new HueError(`no light with id or name '${target}'. Lights: ${known(lights)}`);
  const rows: ResultRow[] = [];
  for (const light of matches) {
    await pace("light");
    await hueRequest(conn, "PUT", `/resource/light/${light.id}`, body);
    rows.push({
      target_type: "light",
      target_id: light.id,
      name: light.metadata?.name ?? null,
      ok: true,
      error: null,
      request: JSON.stringify(body),
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
    const rows = await setLight(
      await connectionFor(params.initCall.bind_call),
      params.args.light,
      changeFrom(params.args),
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

// ------------------------------------------------------------------ set_room

interface SetRoomArgs extends StateArgs {
  room: string;
}

export async function setRoom(conn: BridgeConnection, target: string, change: LightChange): Promise<ResultRow[]> {
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
  await pace("group");
  await hueRequest(conn, "PUT", `/resource/grouped_light/${glId}`, body);
  return [
    {
      target_type: group.type,
      target_id: group.id,
      name: group.metadata?.name ?? null,
      ok: true,
      error: null,
      request: JSON.stringify(body),
    },
  ];
}

export const setRoomFn = defineTableFunction<SetRoomArgs, DoneState>({
  name: "set_room",
  description: "Change every light in a room or zone at once: on/off, brightness, colour temperature or colour",
  args: { room: utf8(), ...STATE_ARG_TYPES },
  argDefaults: STATE_DEFAULTS,
  argDocs: { room: "Room or zone id or name (case-insensitive), as listed by rooms.", ...STATE_DOCS },
  argConstraints: STATE_CONSTRAINTS,
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
    const rows = await setRoom(
      await connectionFor(params.initCall.bind_call),
      params.args.room,
      changeFrom(params.args),
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
        "`request`). Changes real lights: call it only when the user asks for it.",
      docMd:
        "## set_room(room, power :=, brightness :=, kelvin :=, color :=, transition_ms :=)\n\n" +
        "Change every light in a room or zone at once.",
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

export async function recallScene(conn: BridgeConnection, target: string, room: string | null): Promise<ResultRow[]> {
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
  await pace("group");
  await hueRequest(conn, "PUT", `/resource/scene/${scene.id}`, body);
  return [
    {
      target_type: "scene",
      target_id: scene.id,
      name: scene.metadata?.name ?? null,
      ok: true,
      error: null,
      request: JSON.stringify(body),
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
    const rows = await recallScene(await connectionFor(params.initCall.bind_call), params.args.scene, params.args.room);
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

/** set_lights' stream state: the ATTACH options, '' when not given. */
interface AttachedOptions {
  bridge: string;
  app_key: string;
}

export const setLightsFn = defineTableInOutFunction<StateArgs, AttachedOptions>({
  name: "set_lights",
  description: "Apply one change to every light listed by a query (its light_id column)",
  namedArgs: STATE_ARG_TYPES,
  argDefaults: STATE_DEFAULTS,
  argDocs: STATE_DOCS,
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
  // Capture the ATTACH options on the init turn. Over HTTP, later exchange
  // turns see attach_opaque_data still sealed (SDK 0.48.1) and call
  // initialState again before restoring the saved state, so this must not
  // throw; the saved options ride in the stream state, which the SDK carries
  // in an AEAD-encrypted, caller-bound token (and never stores, as set_lights
  // has no finalize).
  initialState: (params): AttachedOptions => {
    const opts = decodeAttachOptions(params.initCall.bind_call.attach_opaque_data);
    return { bridge: opts.bridge ?? "", app_key: opts.app_key ?? "" };
  },
  process: async (params, opts, batch, out) => {
    const conn = await resolveConnection(opts);
    const body = buildStateBody(changeFrom(params.args));
    const ids = batch.getChild("light_id");
    const nameCol = batch.getChild("name");
    const rows: ResultRow[] = [];
    for (let i = 0; i < batch.numRows; i++) {
      const id = ids?.get(i) as string | null;
      const name = (nameCol?.get(i) as string | null | undefined) ?? null;
      if (id == null) {
        rows.push({ target_type: "light", target_id: "", name, ok: false, error: "light_id is NULL", request: null });
        continue;
      }
      try {
        await pace("light");
        await hueRequest(conn, "PUT", `/resource/light/${encodeURIComponent(id)}`, body);
        rows.push({ target_type: "light", target_id: id, name, ok: true, error: null, request: JSON.stringify(body) });
      } catch (err) {
        rows.push({
          target_type: "light",
          target_id: id,
          name,
          ok: false,
          error: (err as Error).message,
          request: JSON.stringify(body),
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

// The SDK adds the TABLE argument ("data") without a description; document it
// so `vgi_function_arguments()` explains what the input query must contain.
for (const spec of setLightsFn.argumentSpecs) {
  if (spec.isTableInput) {
    spec.doc =
      "Input query: one row per light to change, with a `light_id` column (from hue.main.lights) " +
      "and optionally a `name` column that is echoed back.";
  }
}
