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
 *   UPDATE hue.main.lights SET color_x = 0.17, color_y = 0.7 WHERE name = 'Sofa lamp';
 *   UPDATE hue.main.lights SET gradient_hex = ['#ff0000', '#0000ff'], gradient_mode = 'segmented_palette'
 *     WHERE name = 'Hallway strip';
 *   UPDATE hue.main.lights SET effect = 'candle' WHERE name = 'Sofa lamp';
 *
 * Updatable: is_on, brightness, color_temperature_kelvin, color_x, color_y, color_hex,
 * gradient_hex, gradient_xy, gradient_mode, effect, name.
 * Everything else (room, reachable, model, ids, ...) belongs to the bridge or
 * the device: changing it is refused, for every row, before anything is sent. Each changed
 * light gets one PUT (two for a rename with a state change), started at ~10 per second as
 * Hue requires and pipelined up to MAX_IN_FLIGHT at a time; a refusal by the bridge fails
 * the statement once the requests in flight finish, and lights changed before it stay changed.
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
import { senderFor } from "./dispatch.ts";
import {
  buildStateBody,
  COLOR_XY_CONFLICT,
  checkUnit,
  GRADIENT_COLOR_CONFLICT,
  getResources,
  type HueDevice,
  HueError,
  type HueGroup,
  type HueLight,
  type HueZigbee,
  type LightChange,
  parseColor,
  rgbToXy,
  type Xy,
} from "./hue.ts";
import { applyToRow, LIGHTS, lightRows, withPendingChanges } from "./inventory.ts";
import type { StagedRequest } from "./transactions.ts";

/** The columns `UPDATE hue.main.lights SET ...` may change. */
export const UPDATABLE_LIGHT_COLUMNS = [
  "is_on",
  "brightness",
  "color_temperature_kelvin",
  "color_x",
  "color_y",
  "color_hex",
  "gradient_hex",
  "gradient_xy",
  "gradient_mode",
  "effect",
  "name",
] as const;
type Updatable = (typeof UPDATABLE_LIGHT_COLUMNS)[number];

type Row = Record<string, unknown>;

/** Refuse an UPDATE that names a column the lights table does not have. */
export function checkKnownColumns(columns: readonly string[]): void {
  const unknown = columns.filter((c) => c !== "rowid" && !LIGHTS.names.includes(c));
  if (unknown.length) throw new HueError(`hue.main.lights has no column ${unknown.map((c) => `'${c}'`).join(", ")}`);
}

/** Arrow values (list Vectors, StructRows) as plain arrays and objects. */
export function plain(v: unknown): unknown {
  return v != null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v;
}

function same(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (typeof a === "object" || typeof b === "object") {
    if (typeof a !== "object" || typeof b !== "object") return false;
    const ra = a as Row;
    const rb = b as Row;
    return [...new Set([...Object.keys(ra), ...Object.keys(rb)])].every((k) => same(ra[k], rb[k]));
  }
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return Number.isNaN(Number(a)) ? a === b : Number(a) === Number(b);
}

/** What a light can take: colour, a gradient (how many points, which modes), effects. */
export interface LightCaps {
  name: string;
  color: boolean;
  /** `modes` null: unknown, not checked. */
  gradient: { pointsCapable: number; modes: string[] | null } | null;
  /** null: no effects; an empty list: unknown, not checked. */
  effects: string[] | null;
}

export function lightCaps(l: HueLight): LightCaps {
  return {
    name: l.metadata?.name ?? l.id,
    color: l.color != null,
    gradient: l.gradient
      ? { pointsCapable: l.gradient.points_capable ?? 0, modes: l.gradient.mode_values ?? null }
      : null,
    effects: l.effects ? (l.effects.effect_values ?? []) : null,
  };
}

/** The capabilities a lights row shows (when the bridge resource is not at hand). */
export function capsFromRow(row: Row): LightCaps {
  return {
    name: String(row.name ?? row.light_id),
    color: row.color_x != null,
    gradient:
      row.gradient_points_capable != null ? { pointsCapable: Number(row.gradient_points_capable), modes: null } : null,
    effects: row.effect != null ? [] : null,
  };
}

const GRADIENT_NULL = "gradient points must not be NULL";

/** The gradient points a SET of gradient_hex / gradient_xy asks for, validated. */
function gradientPointsFrom(column: "gradient_hex" | "gradient_xy", value: unknown): Xy[] {
  const items = plain(value) as unknown[];
  if (column === "gradient_hex") {
    return items.map((h) => {
      if (h == null) throw new HueError(GRADIENT_NULL);
      return rgbToXy(parseColor(String(h)));
    });
  }
  return items.map((p) => {
    const { x, y } = (p ?? {}) as { x?: unknown; y?: unknown };
    if (x == null || y == null) throw new HueError(GRADIENT_NULL);
    const [nx, ny] = [Number(x), Number(y)];
    if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) {
      throw new HueError(`gradient x and y must be 0–1, got (${nx}, ${ny})`);
    }
    return { x: nx, y: ny };
  });
}

/**
 * What one input row asks to change, relative to the light's current row.
 *
 * DuckDB passes the SET columns, or every column when the statement has
 * RETURNING, so a column is only a change when its value differs from the
 * light's current one. A differing read-only column (room, reachable, ...) is
 * refused; an unchanged column is left alone, which keeps the colour and the
 * white temperature (both always present) from being sent back together.
 *
 * `caps` says what the light supports; everything is checked here, before
 * anything is sent or staged.
 */
export function rowChange(
  batch: VgiBatch,
  i: number,
  current: Row,
  caps: LightCaps = capsFromRow(current),
): { change: LightChange; name: string | null } {
  const change: LightChange = {};
  let name: string | null = null;
  const refused: string[] = [];
  const set = new Map<string, unknown>();
  for (const f of batch.schema.fields) {
    if (f.name === "rowid") continue;
    const value = plain(batch.getChild(f.name)?.get(i) ?? null);
    if (same(value, current[f.name])) continue;
    if (!UPDATABLE_LIGHT_COLUMNS.includes(f.name as Updatable)) {
      refused.push(f.name);
      continue;
    }
    if (value == null) throw new HueError(`cannot SET ${f.name} = NULL on a light`);
    set.set(f.name, value);
  }
  if (refused.length) {
    throw new HueError(
      `cannot UPDATE ${refused.map((c) => `'${c}'`).join(", ")} of hue.main.lights; ` +
        `updatable columns: ${UPDATABLE_LIGHT_COLUMNS.join(", ")}`,
    );
  }
  const has = (c: Updatable) => set.has(c);
  const xySet = has("color_x") || has("color_y");
  const gradientSet = has("gradient_hex") || has("gradient_xy") || has("gradient_mode");
  if (has("color_hex") && xySet) throw new HueError(COLOR_XY_CONFLICT);
  if (has("gradient_hex") && has("gradient_xy")) throw new HueError("set either gradient_hex or gradient_xy, not both");
  if (gradientSet && (has("color_hex") || xySet || has("color_temperature_kelvin"))) {
    throw new HueError(GRADIENT_COLOR_CONFLICT);
  }
  if (xySet && !caps.color) throw new HueError(`light '${caps.name}' does not support color`);
  if (gradientSet && !caps.gradient) throw new HueError(`light '${caps.name}' does not support gradients`);
  if (has("effect") && caps.effects == null) throw new HueError(`light '${caps.name}' does not support effects`);

  for (const [column, value] of set) {
    if (column === "is_on") change.on = Boolean(value);
    else if (column === "brightness") change.brightness = Number(value);
    else if (column === "color_temperature_kelvin") change.kelvin = Number(value);
    else if (column === "color_hex") change.color = String(value);
    else if (column === "name") name = String(value);
  }
  if (xySet) {
    const x = Number(has("color_x") ? set.get("color_x") : current.color_x);
    const y = Number(has("color_y") ? set.get("color_y") : current.color_y);
    checkUnit("color_x", x);
    checkUnit("color_y", y);
    change.xy = { x, y };
  }
  if (gradientSet && caps.gradient) {
    const points = has("gradient_hex")
      ? gradientPointsFrom("gradient_hex", set.get("gradient_hex"))
      : has("gradient_xy")
        ? gradientPointsFrom("gradient_xy", set.get("gradient_xy"))
        : gradientPointsFrom("gradient_xy", current.gradient_xy ?? []);
    if (!has("gradient_hex") && !has("gradient_xy") && points.length < 2) {
      throw new HueError(
        `light '${caps.name}' has no gradient to change the mode of; set gradient_hex or gradient_xy too`,
      );
    }
    const max = caps.gradient.pointsCapable;
    if (points.length < 2 || points.length > max) {
      throw new HueError(`light '${caps.name}' takes 2–${max} gradient points, got ${points.length}`);
    }
    const mode = has("gradient_mode") ? String(set.get("gradient_mode")) : undefined;
    const modes = caps.gradient.modes;
    if (mode !== undefined && modes && !modes.includes(mode)) {
      throw new HueError(`invalid gradient_mode '${mode}' for light '${caps.name}'; allowed: ${modes.join(", ")}`);
    }
    change.gradient = mode === undefined ? { points } : { points, mode };
  }
  if (has("effect")) {
    const effect = String(set.get("effect"));
    if (caps.effects?.length && !caps.effects.includes(effect)) {
      throw new HueError(`invalid effect '${effect}' for light '${caps.name}'; allowed: ${caps.effects.join(", ")}`);
    }
    change.effect = effect;
  }
  if (name !== null && (name.trim() === "" || name.length > 32)) {
    throw new HueError(`light names must be 1-32 characters, got '${name}'`);
  }
  return { change, name };
}

/** The changes for one light: its state change and/or new name. */
export function updateBody(change: LightChange, name: string | null): Record<string, unknown> {
  const hasState = Object.values(change).some((v) => v != null);
  const body = hasState ? buildStateBody(change) : {};
  if (name !== null) body.metadata = { name };
  return body;
}

/**
 * The PUT requests that apply `body`. A real bridge silently ignores state
 * fields (on, dimming, colour) in a PUT that also carries `metadata`, so a
 * rename goes in a request of its own, after the state change.
 */
export function updateRequests(body: Record<string, unknown>): Record<string, unknown>[] {
  const { metadata, ...state } = body;
  return [...(Object.keys(state).length ? [state] : []), ...(metadata ? [{ metadata }] : [])];
}

/** Every PUT an UPDATE sends, in row order; a light's own requests stay in order. */
export function lightUpdateRequests(plan: { old: Row; body: Record<string, unknown> }[]): StagedRequest[] {
  return plan.flatMap(({ old, body }) =>
    updateRequests(body).map((request) => ({ kind: "light" as const, target: String(old.light_id), body: request })),
  );
}

export { applyToRow } from "./inventory.ts";

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
    // Inside a transaction, compare against the rows as that transaction sees them.
    const current = withPendingChanges(lightRows(lights, devices, rooms, zigbee), params.initCall.bind_call);
    const lightById = new Map(lights.map((l) => [l.id, l]));
    const byRowId = new Map<bigint, Row>();
    current.rowid?.forEach((rowid, i) => {
      byRowId.set(rowid as bigint, Object.fromEntries(LIGHTS.names.map((n) => [n, current[n]?.[i] ?? null])));
    });

    // Validate every row before sending anything, so a bad value changes no light.
    const plan = Array.from({ length: batch.numRows }, (_, i) => {
      const rowid = batch.getChild("rowid")?.get(i) as bigint;
      const old = byRowId.get(BigInt(rowid));
      if (!old) throw new HueError(`light with rowid ${rowid} no longer exists on the bridge`);
      const light = lightById.get(String(old.light_id));
      const { change, name } = rowChange(batch, i, old, light ? lightCaps(light) : capsFromRow(old));
      return { old, body: updateBody(change, name) };
    });
    // One send for the whole batch, so the requests are pipelined across lights.
    await senderFor(params.initCall.bind_call, conn)(lightUpdateRequests(plan));
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
