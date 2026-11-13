/**
 * A small client for the Philips Hue bridge's CLIP v2 API, plus the pure
 * helpers (colour conversion, resource joining) the SQL functions share.
 *
 * Connection settings come from the ATTACH options (`bridge`, `app_key`),
 * falling back to the `HUE_BRIDGE` / `HUE_APP_KEY` environment variables.
 * See `attach.ts` for how the options travel to each function call.
 *
 * The bridge serves HTTPS with a certificate signed by the Signify root CA
 * (CN = bridge id), which no public trust store contains, so certificate
 * verification is skipped for the bridge. A `bridge` value that starts with
 * `http://` or `https://` is used verbatim (the tests point it at a mock).
 */

import { discoverBridge, isBridgeId } from "./discovery.ts";
import { log } from "./log.ts";
import { VERSION } from "./meta.ts";

export const BRIDGE_ENV_VAR = "HUE_BRIDGE";
export const APP_KEY_ENV_VAR = "HUE_APP_KEY";
export const TIMEOUT_MS = 10_000;
export const MAX_ATTEMPTS = 4;
/** Hue asks for at most ~10 light commands and ~1 group command per second. */
export const LIGHT_COMMAND_GAP_MS = 100;
export const GROUP_COMMAND_GAP_MS = 1000;
const USER_AGENT = `vgi-hue-worker/${VERSION}`;

/** Options given on ATTACH; either may be absent. */
export interface BridgeOptions {
  bridge?: string | null;
  app_key?: string | null;
  /** Stage changes in DuckDB transactions and send them at COMMIT (transactions.ts). */
  transactional?: boolean;
}

export interface BridgeConnection {
  baseUrl: string;
  appKey: string;
}

/** The bridge refused a request or could not be reached. */
export class HueError extends Error {}

/**
 * Combine ATTACH options with the environment. The bridge may be an address,
 * an http(s) URL, a bridge id (16 hex digits), or absent; the last two are
 * resolved by discovery on the local network (see discovery.ts).
 */
export async function resolveConnection(
  options: BridgeOptions,
  env: Record<string, string | undefined> = process.env,
  discover: typeof discoverBridge = discoverBridge,
): Promise<BridgeConnection> {
  const bridge = (options.bridge || env[BRIDGE_ENV_VAR] || "").trim();
  const appKey = (options.app_key || env[APP_KEY_ENV_VAR] || "").trim();
  if (!appKey) {
    throw new HueError(
      "No Hue app key configured. Pass it when attaching: " +
        "ATTACH 'hue' (TYPE vgi, LOCATION '...', app_key getenv('HUE_APP_KEY')), " +
        `or set the ${APP_KEY_ENV_VAR} environment variable for the worker. ` +
        "The bridge address is optional: without it the bridge is discovered on your network.",
    );
  }
  if (!bridge || isBridgeId(bridge)) {
    try {
      const found = await discover(bridge || null, { env });
      return { baseUrl: found.url, appKey };
    } catch (err) {
      throw new HueError((err as Error).message);
    }
  }
  const baseUrl = /^https?:\/\//i.test(bridge) ? bridge.replace(/\/+$/, "") : `https://${bridge}`;
  return { baseUrl, appKey };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface HueEnvelope<T> {
  data?: T[];
  errors?: { description?: string }[];
}

/** Send one request to the bridge, retrying 429/503 and network errors with backoff. */
export async function hueRequest<T = unknown>(
  conn: BridgeConnection,
  method: "GET" | "PUT",
  path: string,
  body?: unknown,
): Promise<T[]> {
  const url = `${conn.baseUrl}/clip/v2${path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    "hue-application-key": conn.appKey,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // Bun-specific: the bridge's certificate is self-signed (see header comment).
        tls: { rejectUnauthorized: false },
      } as RequestInit);
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        throw new HueError(
          `${method} ${path}: cannot reach the Hue bridge at ${conn.baseUrl}: ${(err as Error).message}`,
        );
      }
      await sleep(250 * 2 ** attempt);
      continue;
    }
    const retryable = response.status === 429 || response.status === 503;
    if (retryable && attempt < MAX_ATTEMPTS) {
      await response.body?.cancel();
      const retryAfter = response.headers.get("Retry-After");
      const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 250 * 2 ** attempt;
      log.debug(`${method} ${path}: HTTP ${response.status}, retrying in ${delay} ms`);
      await sleep(Math.min(delay, 10_000));
      continue;
    }
    const text = await response.text();
    let parsed: HueEnvelope<T> = {};
    try {
      parsed = text ? (JSON.parse(text) as HueEnvelope<T>) : {};
    } catch {
      // Not JSON: fall through to the status check with the raw text.
    }
    const errors = (parsed.errors ?? []).map((e) => e.description).filter(Boolean);
    if (!response.ok) {
      const detail = errors.length ? errors.join("; ") : text.slice(0, 300);
      const hint = response.status === 403 || response.status === 401 ? " (is app_key correct?)" : "";
      throw new HueError(`${method} ${path} failed with HTTP ${response.status}${hint}: ${detail}`);
    }
    if (errors.length) throw new HueError(`${method} ${path}: the bridge reported: ${errors.join("; ")}`);
    return parsed.data ?? [];
  }
}

// ----------------------------------------------------------------- resources

export interface ResourceRef {
  rid: string;
  rtype: string;
}

export interface HueLight {
  id: string;
  owner: ResourceRef;
  metadata?: { name?: string; archetype?: string };
  on?: { on: boolean };
  dimming?: { brightness: number };
  color_temperature?: { mirek: number | null; mirek_valid?: boolean };
  color?: { xy: { x: number; y: number } };
  /** Gradient lights (lightstrips, Play gradient, ...): CLIP v2 `gradient`. */
  gradient?: {
    points?: { color?: { xy?: { x: number; y: number } } }[];
    points_capable?: number;
    mode?: string;
    mode_values?: string[];
    pixel_count?: number;
  };
  /** Lights with built-in effects: CLIP v2 `effects`. */
  effects?: { status?: string; status_values?: string[]; effect_values?: string[] };
}

/** A CIE 1931 xy chromaticity. */
export interface Xy {
  x: number;
  y: number;
}

export interface HueDevice {
  id: string;
  metadata?: { name?: string; archetype?: string };
  product_data?: { model_id?: string; product_name?: string; manufacturer_name?: string };
  services?: ResourceRef[];
}

export interface HueGroup {
  id: string;
  type: "room" | "zone";
  metadata?: { name?: string; archetype?: string };
  children?: ResourceRef[];
  services?: ResourceRef[];
}

export interface HueGroupedLight {
  id: string;
  on?: { on: boolean };
  dimming?: { brightness: number };
}

export interface HueScene {
  id: string;
  metadata?: { name?: string };
  group?: ResourceRef;
  status?: { active?: string };
}

export interface HueZigbee {
  id: string;
  owner: ResourceRef;
  status?: string;
}

/** Any sensor-like service: motion, temperature, light_level, contact, device_power. */
export interface HueSensor {
  id: string;
  type: string;
  owner: ResourceRef;
  enabled?: boolean;
  motion?: { motion?: boolean; motion_report?: { changed?: string; motion?: boolean } };
  temperature?: { temperature?: number; temperature_report?: { changed?: string; temperature?: number } };
  light?: { light_level?: number; light_level_report?: { changed?: string; light_level?: number } };
  contact_report?: { changed?: string; state?: string };
  power_state?: { battery_state?: string; battery_level?: number };
}

export const getResources = <T>(conn: BridgeConnection, type: string) =>
  hueRequest<T>(conn, "GET", `/resource/${type}`);

/** Index rooms by the devices they contain, so a light/sensor can find its room. */
export function roomByDevice(groups: HueGroup[]): Map<string, HueGroup> {
  const out = new Map<string, HueGroup>();
  for (const g of groups) {
    if (g.type !== "room") continue;
    for (const child of g.children ?? []) if (child.rtype === "device") out.set(child.rid, g);
  }
  return out;
}

/** Reachability (zigbee status 'connected') by owning device id. */
export function reachableByDevice(zigbee: HueZigbee[]): Map<string, boolean> {
  return new Map(zigbee.map((z) => [z.owner.rid, z.status === "connected"]));
}

/** The light ids a room or zone covers: a room lists devices, a zone lists lights. */
export function lightsInGroup(group: HueGroup, lights: HueLight[]): HueLight[] {
  const children = group.children ?? [];
  const devices = new Set(children.filter((c) => c.rtype === "device").map((c) => c.rid));
  const lightIds = new Set(children.filter((c) => c.rtype === "light").map((c) => c.rid));
  return lights.filter((l) => lightIds.has(l.id) || devices.has(l.owner.rid));
}

// ---------------------------------------------------------------- colour math

/** Kelvin to Hue mirek, clamped to the range Hue lamps accept (153–500). */
export function kelvinToMirek(kelvin: number): number {
  return Math.min(500, Math.max(153, Math.round(1_000_000 / kelvin)));
}

export function mirekToKelvin(mirek: number): number {
  return Math.round(1_000_000 / mirek);
}

const NAMED_COLORS: Record<string, string> = {
  red: "#ff0000",
  orange: "#ff8000",
  yellow: "#ffff00",
  green: "#00ff00",
  cyan: "#00ffff",
  blue: "#0000ff",
  purple: "#8000ff",
  magenta: "#ff00ff",
  pink: "#ff69b4",
  white: "#ffffff",
};

/** Parse '#rrggbb', 'rrggbb', '#rgb' or a basic colour name into 0–255 RGB. */
export function parseColor(color: string): [number, number, number] {
  const raw = NAMED_COLORS[color.trim().toLowerCase()] ?? color.trim();
  let hex = raw.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(hex)) {
    throw new HueError(`invalid color '${color}': use '#rrggbb' or one of ${Object.keys(NAMED_COLORS).join(", ")}`);
  }
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

const gammaExpand = (c: number) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92);
const gammaCompress = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** sRGB (0–255) to CIE xy, using the Wide-gamut D65 matrix Signify documents. */
export function rgbToXy([r8, g8, b8]: [number, number, number]): { x: number; y: number } {
  const [r, g, b] = [r8, g8, b8].map((c) => gammaExpand(c / 255)) as [number, number, number];
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = X + Y + Z;
  if (sum === 0) return { x: 0.3127, y: 0.329 }; // black: D65 white point
  return { x: round4(X / sum), y: round4(Y / sum) };
}

const toHex = (rgb: number[]) =>
  `#${rgb
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/** CIE xy to an '#rrggbb' approximation at full brightness. */
export function xyToHex(x: number, y: number): string {
  if (y <= 0) return "#000000";
  const Y = 1;
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);
  let rgb = [
    X * 1.656492 - Y * 0.354851 - Z * 0.255038,
    -X * 0.707196 + Y * 1.655397 + Z * 0.036152,
    X * 0.051713 - Y * 0.121364 + Z * 1.01153,
  ].map((c) => Math.max(0, c));
  const max = Math.max(...rgb, 1e-9);
  rgb = rgb.map((c) => gammaCompress(c / max) * 255);
  return toHex(rgb);
}

/** Colour temperature (Kelvin) to an '#rrggbb' approximation (Tanner Helland's fit). */
export function kelvinToHex(kelvin: number): string {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return toHex([r, g, b]);
}

/** Hue reports light level as 10000*log10(lux)+1; convert back to lux. */
export function lightLevelToLux(level: number): number {
  return Math.round(10 ** ((level - 1) / 10_000) * 100) / 100;
}

// ------------------------------------------------------------------- commands

/** The state changes a set_* call asks for; NULL/undefined fields are left alone. */
export interface LightChange {
  on?: boolean | null;
  brightness?: number | null;
  kelvin?: number | null;
  color?: string | null;
  /** A CIE xy colour, sent as is (UPDATE ... SET color_x / color_y). */
  xy?: Xy | null;
  /** Gradient points (and optionally the mode) for a gradient light. */
  gradient?: { points: Xy[]; mode?: string } | null;
  /** A light effect ('no_effect' stops one). */
  effect?: string | null;
  transition_ms?: number | null;
}

/** Refuse a chromaticity coordinate outside 0–1. */
export function checkUnit(what: string, value: number): void {
  if (!(value >= 0 && value <= 1)) throw new HueError(`${what} must be 0–1, got ${value}`);
}

export const COLOR_XY_CONFLICT = "set either color_hex or color_x/color_y, not both";
export const GRADIENT_COLOR_CONFLICT =
  "set either a gradient or a single colour (color_hex, color_x/color_y, color_temperature_kelvin), not both";

/** The CLIP v2 `gradient` PUT object. */
export function gradientBody(points: Xy[], mode?: string | null): Record<string, unknown> {
  return {
    points: points.map(({ x, y }) => ({ color: { xy: { x, y } } })),
    ...(mode != null ? { mode } : {}),
  };
}

/** Build the CLIP v2 PUT body for a light or grouped_light. */
export function buildStateBody(change: LightChange): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const { on, brightness, kelvin, color, xy, gradient, effect, transition_ms } = change;
  if (kelvin != null && color != null) throw new HueError("pass either kelvin or color, not both");
  if (color != null && xy != null) throw new HueError(COLOR_XY_CONFLICT);
  if (gradient != null && (color != null || xy != null || kelvin != null)) throw new HueError(GRADIENT_COLOR_CONFLICT);
  if (brightness != null) {
    if (brightness < 0 || brightness > 100) throw new HueError(`brightness must be 0–100, got ${brightness}`);
    if (brightness === 0) {
      if (on === true) throw new HueError("brightness 0 turns the light off; it cannot be combined with power := true");
      body.on = { on: false };
    } else {
      body.dimming = { brightness };
      // Setting a brightness implies the caller wants light, unless they said otherwise.
      if (on == null) body.on = { on: true };
    }
  }
  if (on != null) body.on = { on };
  if (kelvin != null) {
    if (kelvin < 2000 || kelvin > 6500) throw new HueError(`kelvin must be 2000–6500, got ${kelvin}`);
    body.color_temperature = { mirek: kelvinToMirek(kelvin) };
  }
  if (color != null) body.color = { xy: rgbToXy(parseColor(color)) };
  if (xy != null) {
    checkUnit("color_x", xy.x);
    checkUnit("color_y", xy.y);
    body.color = { xy: { x: xy.x, y: xy.y } };
  }
  if (gradient != null) body.gradient = gradientBody(gradient.points, gradient.mode);
  if (effect != null) body.effects = { effect };
  if (transition_ms != null) {
    if (transition_ms < 0) throw new HueError(`transition_ms must be >= 0, got ${transition_ms}`);
    body.dynamics = { duration: Math.round(transition_ms) };
  }
  if (Object.keys(body).length === 0 || (Object.keys(body).length === 1 && body.dynamics)) {
    throw new HueError("nothing to change: pass at least one of power, brightness, kelvin or color");
  }
  return body;
}

/** When the last command of each kind was (or is booked to be) started. */
const lastCommandAt: Record<string, number> = {};

/**
 * Space commands of one kind out so a bulk update stays inside Hue's rate
 * limits. Each call books the next free start slot before it sleeps, so
 * concurrent callers get distinct slots `gapMs` apart.
 */
export async function pace(
  kind: "light" | "group",
  gapMs = kind === "light" ? LIGHT_COMMAND_GAP_MS : GROUP_COMMAND_GAP_MS,
) {
  const now = Date.now();
  const slot = Math.max(now, (lastCommandAt[kind] ?? 0) + gapMs);
  lastCommandAt[kind] = slot;
  if (slot > now) await sleep(slot - now);
}

/** At most this many PUTs are in flight at once (see putAll). */
export const MAX_IN_FLIGHT = 4;

/** One PUT to `/resource/<kind>/<target>`. */
export interface PutRequest {
  kind: string;
  target: string;
  body: unknown;
}

/**
 * Send PUTs to the bridge, pipelined. Start times stay paced (`pace`: ~10
 * light / ~1 group command per second), but a request does not wait for the
 * previous response: up to MAX_IN_FLIGHT are in flight at once, so a bulk
 * update is bound by Hue's rate limit instead of by round trips.
 *
 * Order: requests to the same light run one after another, in the order
 * given. A group command (grouped_light, scene) covers many lights, so it
 * runs alone: it starts once everything before it has finished, and nothing
 * after it starts until it has finished.
 *
 * Each request retries on its own (hueRequest). On the first failure no new
 * request starts; the ones in flight finish, then the first error is thrown.
 * Requests that succeeded stay applied. `onSent` is called for each request
 * the bridge accepted.
 */
export async function putAll(
  conn: BridgeConnection,
  requests: readonly PutRequest[],
  onSent: (r: PutRequest) => void = () => {},
): Promise<void> {
  const pending = [...requests];
  const inFlight = new Set<Promise<void>>();
  const busy = new Set<string>(); // targets with a request in flight
  let failure: { error: unknown } | null = null;

  /** Index of the next request that may start now, or -1. */
  const next = () => {
    if (inFlight.size >= MAX_IN_FLIGHT) return -1;
    for (let i = 0; i < pending.length; i++) {
      const r = pending[i] as PutRequest;
      if (r.kind !== "light") return i === 0 && inFlight.size === 0 ? 0 : -1; // a barrier
      if (!busy.has(r.target)) return i;
    }
    return -1;
  };

  while (pending.length && !failure) {
    const i = next();
    if (i < 0) {
      await Promise.race(inFlight);
      continue;
    }
    const [r] = pending.splice(i, 1) as [PutRequest];
    busy.add(r.target);
    await pace(r.kind === "light" ? "light" : "group");
    if (failure) break; // an in-flight request failed while this one waited for its slot
    const p: Promise<void> = hueRequest(conn, "PUT", `/resource/${r.kind}/${encodeURIComponent(r.target)}`, r.body)
      .then(
        () => onSent(r),
        (error) => {
          failure ??= { error };
        },
      )
      .finally(() => {
        busy.delete(r.target);
        inFlight.delete(p);
      });
    inFlight.add(p);
    if (r.kind !== "light") await p; // a barrier runs alone
  }
  await Promise.all(inFlight);
  if (failure) throw (failure as { error: unknown }).error;
}
