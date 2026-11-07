/**
 * `UPDATE hue.main.lights SET ...`: the lights table is writable.
 *
 *   UPDATE hue.main.lights SET is_on = true, brightness = 40 WHERE room = 'Kitchen';
 *   UPDATE hue.main.lights SET color_hex = '#ff8000' WHERE name LIKE 'Signe%' RETURNING name, color_hex;
 *   UPDATE hue.main.lights SET name = 'Reading lamp' WHERE light_id = '...';
 *
 * DuckDB scans the table (filtering with WHERE), then hands this function the
 * changed columns plus each row's `rowid`. Row ids are a stable hash of the
 * light's CLIP v2 id (`lightRowId`), so they mean the same light in every
 * scan, process and session without any stored mapping.
 *
 * Updatable: is_on, brightness, color_temperature_kelvin, color_hex, name.
 * Everything else (room, reachable, model, ids, ...) belongs to the bridge or
 * the device: changing it is refused, for every row, before anything is sent. Each changed
 * light gets one PUT, paced at ~10 per second as Hue requires; a refusal by
 * the bridge fails the statement, and lights changed before it stay changed.
 */

import {
  defineTableInOutFunction,
  FunctionStability,
  type VgiBatch,
  writeOptions,
  writeResultBatch,
  writeResultSchema,
} from "@query-farm/vgi";
import { connectionFor } from "./attach.ts";
import {
  buildStateBody,
  getResources,
  type HueDevice,
  HueError,
  type HueGroup,
  type HueLight,
  type HueZigbee,
  hueRequest,
  kelvinToHex,
  type LightChange,
  mirekToKelvin,
  pace,
  xyToHex,
} from "./hue.ts";
import { LIGHTS, lightRows } from "./inventory.ts";

/** The columns `UPDATE hue.main.lights SET ...` may change. */
export const UPDATABLE_LIGHT_COLUMNS = [
  "is_on",
  "brightness",
  "color_temperature_kelvin",
  "color_hex",
  "name",
] as const;
type Updatable = (typeof UPDATABLE_LIGHT_COLUMNS)[number];

type Row = Record<string, unknown>;

/** Refuse an UPDATE that names a column the lights table does not have. */
export function checkKnownColumns(columns: readonly string[]): void {
  const unknown = columns.filter((c) => c !== "rowid" && !LIGHTS.names.includes(c));
  if (unknown.length) throw new HueError(`hue.main.lights has no column ${unknown.map((c) => `'${c}'`).join(", ")}`);
}

const same = (a: unknown, b: unknown) =>
  a == null || b == null
    ? a == null && b == null
    : typeof a === "string" && typeof b === "string"
      ? a.toLowerCase() === b.toLowerCase()
      : Number.isNaN(Number(a))
        ? a === b
        : Number(a) === Number(b);

/**
 * What one input row asks to change, relative to the light's current row.
 *
 * DuckDB passes the SET columns, or every column when the statement has
 * RETURNING, so a column is only a change when its value differs from the
 * light's current one. A differing read-only column (room, reachable, ...) is
 * refused; an unchanged column is left alone, which keeps the colour and the
 * white temperature (both always present) from being sent back together.
 */
export function rowChange(batch: VgiBatch, i: number, current: Row): { change: LightChange; name: string | null } {
  const change: LightChange = {};
  let name: string | null = null;
  const refused: string[] = [];
  for (const f of batch.schema.fields) {
    if (f.name === "rowid") continue;
    const value = batch.getChild(f.name)?.get(i) ?? null;
    if (same(value, current[f.name])) continue;
    if (!UPDATABLE_LIGHT_COLUMNS.includes(f.name as Updatable)) {
      refused.push(f.name);
      continue;
    }
    if (value == null) throw new HueError(`cannot SET ${f.name} = NULL on a light`);
    if (f.name === "is_on") change.on = Boolean(value);
    else if (f.name === "brightness") change.brightness = Number(value);
    else if (f.name === "color_temperature_kelvin") change.kelvin = Number(value);
    else if (f.name === "color_hex") change.color = String(value);
    else name = String(value);
  }
  if (refused.length) {
    throw new HueError(
      `cannot UPDATE ${refused.map((c) => `'${c}'`).join(", ")} of hue.main.lights; ` +
        `updatable columns: ${UPDATABLE_LIGHT_COLUMNS.join(", ")}`,
    );
  }
  if (name !== null && (name.trim() === "" || name.length > 32)) {
    throw new HueError(`light names must be 1-32 characters, got '${name}'`);
  }
  return { change, name };
}

/** The PUT body for one light: its state change and/or new name. */
export function updateBody(change: LightChange, name: string | null): Record<string, unknown> {
  const hasState = Object.values(change).some((v) => v != null);
  const body = hasState ? buildStateBody(change) : {};
  if (name !== null) body.metadata = { name };
  return body;
}

/** The row as it reads once the bridge has applied `body` (what RETURNING shows). */
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

export const lightsUpdateFn = defineTableInOutFunction({
  name: "lights_update",
  description: "Backs UPDATE hue.main.lights: apply SET values to each matched light",
  stability: FunctionStability.VOLATILE,
  argDocs: { data: "The changed columns plus rowid of each light to update; supplied by DuckDB." },
  onBind: (params) => {
    checkKnownColumns(params.bindCall.input_schema?.fields.map((f) => f.name) ?? []);
    return { outputSchema: writeResultSchema(writeOptions(params.bindCall).resultMode, LIGHTS.schema) };
  },
  process: async (params, _state, batch, out) => {
    const conn = await connectionFor(params.initCall.bind_call);
    const [lights, devices, rooms, zigbee] = await Promise.all([
      getResources<HueLight>(conn, "light"),
      getResources<HueDevice>(conn, "device"),
      getResources<HueGroup>(conn, "room"),
      getResources<HueZigbee>(conn, "zigbee_connectivity"),
    ]);
    const current = lightRows(lights, devices, rooms, zigbee);
    const byRowId = new Map<bigint, Row>();
    current.rowid?.forEach((rowid, i) => {
      byRowId.set(rowid as bigint, Object.fromEntries(LIGHTS.names.map((n) => [n, current[n]?.[i] ?? null])));
    });

    // Validate every row before sending anything, so a bad value changes no light.
    const plan = Array.from({ length: batch.numRows }, (_, i) => {
      const rowid = batch.getChild("rowid")?.get(i) as bigint;
      const old = byRowId.get(BigInt(rowid));
      if (!old) throw new HueError(`light with rowid ${rowid} no longer exists on the bridge`);
      const { change, name } = rowChange(batch, i, old);
      return { old, body: updateBody(change, name) };
    });
    for (const { old, body } of plan) {
      if (Object.keys(body).length === 0) continue; // nothing differs: no command
      await pace("light");
      await hueRequest(conn, "PUT", `/resource/light/${old.light_id}`, body);
    }
    out.emit(
      writeResultBatch(
        writeOptions(params.initCall.bind_call).resultMode,
        LIGHTS.schema,
        plan.map((p) => p.old),
        plan.map((p) => applyToRow(p.old, p.body)),
      ),
    );
  },
});
