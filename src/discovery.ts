/**
 * Find a Hue bridge on the local network when no `bridge` address was given.
 *
 * Order of attempts:
 *   1. A cached bridge from an earlier discovery, if it still answers.
 *   2. mDNS: a `_hue._tcp.local` query on the LAN (works offline).
 *   3. Signify's cloud discovery endpoint (https://discovery.meethue.com),
 *      which lists bridges that recently checked in from your public IP.
 *
 * Every candidate is confirmed by fetching `/api/config` (unauthenticated),
 * which also gives the bridge id used to de-duplicate and to match a `bridge`
 * option that names a bridge id instead of an address.
 *
 * Environment:
 *   HUE_DISCOVERY=off       disable discovery (an address is then required)
 *   HUE_DISCOVERY_URL       cloud endpoint (default https://discovery.meethue.com)
 *   HUE_DISCOVERY_MDNS=off  skip the mDNS step
 *   HUE_DISCOVERY_SCHEME    scheme for discovered bridges (default https; the
 *                           tests set http to reach the mock bridge)
 */

import { createSocket } from "node:dgram";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log.ts";

export const DEFAULT_DISCOVERY_URL = "https://discovery.meethue.com";
const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const MDNS_WINDOW_MS = 1500;
const PROBE_TIMEOUT_MS = 3000;
const CLOUD_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

/** A confirmed bridge. */
export interface DiscoveredBridge {
  /** Bridge id, lowercase hex (e.g. '001788fffe123456'). */
  id: string;
  name: string | null;
  /** Base URL, e.g. 'https://192.168.1.20'. */
  url: string;
}

/** A discovered address not yet confirmed to be a bridge. */
export interface Candidate {
  host: string;
  port?: number | null;
  /** Bridge id reported by the discovery source, when it gave one. */
  id?: string | null;
}

export interface DiscoveryOptions {
  env?: Record<string, string | undefined>;
  /** Override the sources, for tests. */
  mdns?: () => Promise<Candidate[]>;
  cloud?: () => Promise<Candidate[]>;
  probe?: (url: string) => Promise<{ id: string; name: string | null } | null>;
  cacheFile?: string | null;
}

/** No usable bridge was found, or the choice is ambiguous. */
export class DiscoveryError extends Error {}

/** True when `value` looks like a Hue bridge id rather than an address. */
export function isBridgeId(value: string): boolean {
  return /^[0-9a-f]{16}$/i.test(value);
}

export function candidateUrl(c: Candidate, scheme = "https"): string {
  const host = c.host.includes(":") ? `[${c.host}]` : c.host; // IPv6 literal
  const defaultPort = scheme === "https" ? 443 : 80;
  return c.port && c.port !== defaultPort ? `${scheme}://${host}:${c.port}` : `${scheme}://${host}`;
}

/** Confirm a bridge by reading its unauthenticated config; null when it is not one. */
export async function probeBridge(url: string): Promise<{ id: string; name: string | null } | null> {
  try {
    const response = await fetch(`${url}/api/config`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    if (!response.ok) return null;
    const body = (await response.json()) as { bridgeid?: string; name?: string };
    return body.bridgeid ? { id: body.bridgeid.toLowerCase(), name: body.name ?? null } : null;
  } catch {
    return null;
  }
}

/** Ask Signify's cloud endpoint which bridges sit behind this public IP. */
export async function cloudCandidates(url: string): Promise<Candidate[]> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS) });
    if (!response.ok) {
      log.debug(`cloud discovery: HTTP ${response.status}`);
      return [];
    }
    const body = (await response.json()) as { id?: string; internalipaddress?: string; port?: number }[];
    return (Array.isArray(body) ? body : [])
      .filter((b) => typeof b.internalipaddress === "string")
      .map((b) => ({ host: b.internalipaddress as string, port: b.port ?? null, id: b.id ?? null }));
  } catch (err) {
    log.debug(`cloud discovery failed: ${(err as Error).message}`);
    return [];
  }
}

/** A DNS query packet asking for PTR records of `_hue._tcp.local`. */
export function mdnsQuery(): Uint8Array {
  const labels = ["_hue", "_tcp", "local"];
  const name = labels.flatMap((l) => [l.length, ...new TextEncoder().encode(l)]);
  // id 0, flags 0, 1 question; then QNAME, QTYPE=PTR(12), QCLASS=IN(1).
  return new Uint8Array([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...name, 0, 0, 12, 0, 1]);
}

/**
 * Send one mDNS query from an ephemeral port (a "legacy unicast" query, so
 * responders answer us directly) and collect the address of every responder.
 * The /api/config probe afterwards weeds out anything that is not a bridge.
 */
export function mdnsCandidates(windowMs = MDNS_WINDOW_MS): Promise<Candidate[]> {
  return new Promise((resolve) => {
    const hosts = new Set<string>();
    let socket: ReturnType<typeof createSocket>;
    try {
      socket = createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    const finish = () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve([...hosts].map((host) => ({ host })));
    };
    socket.on("error", (err) => {
      log.debug(`mDNS discovery failed: ${err.message}`);
      finish();
    });
    socket.on("message", (msg, rinfo) => {
      // Only answers (QR bit set) to our query (id 0).
      if (msg.length >= 12 && msg[0] === 0 && msg[1] === 0 && ((msg[2] ?? 0) & 0x80) !== 0) hosts.add(rinfo.address);
    });
    socket.bind(0, () => {
      socket.send(mdnsQuery(), MDNS_PORT, MDNS_ADDRESS, (err) => {
        if (err) log.debug(`mDNS send failed: ${err.message}`);
      });
      setTimeout(finish, windowMs);
    });
  });
}

function defaultCacheFile(env: Record<string, string | undefined>): string {
  const base = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "vgi-hue", "bridges.json");
}

interface CacheFile {
  [source: string]: { savedAt: number; bridges: DiscoveredBridge[] };
}

function readCache(file: string | null, key: string): DiscoveredBridge[] {
  if (!file) return [];
  try {
    const entry = (JSON.parse(readFileSync(file, "utf8")) as CacheFile)[key];
    return entry && Date.now() - entry.savedAt < CACHE_TTL_MS ? entry.bridges : [];
  } catch {
    return [];
  }
}

function writeCache(file: string | null, key: string, bridges: DiscoveredBridge[]): void {
  if (!file) return;
  try {
    let all: CacheFile = {};
    try {
      all = JSON.parse(readFileSync(file, "utf8")) as CacheFile;
    } catch {
      // first write
    }
    all[key] = { savedAt: Date.now(), bridges };
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(all, null, 2));
  } catch (err) {
    log.debug(`could not write bridge cache ${file}: ${(err as Error).message}`);
  }
}

/** Probe candidates in parallel and keep the confirmed bridges, one per id. */
async function confirm(
  candidates: Candidate[],
  scheme: string,
  probe: NonNullable<DiscoveryOptions["probe"]>,
): Promise<DiscoveredBridge[]> {
  const urls = [...new Set(candidates.map((c) => candidateUrl(c, scheme)))];
  const results = await Promise.all(urls.map(async (url) => ({ url, info: await probe(url) })));
  const byId = new Map<string, DiscoveredBridge>();
  for (const { url, info } of results) {
    if (info && !byId.has(info.id)) byId.set(info.id, { id: info.id, name: info.name, url });
  }
  return [...byId.values()];
}

/** Pick the one bridge to use, or explain why there isn't exactly one. */
export function chooseBridge(bridges: DiscoveredBridge[], wantedId: string | null): DiscoveredBridge {
  const pool = wantedId ? bridges.filter((b) => b.id === wantedId.toLowerCase()) : bridges;
  const list = bridges.map((b) => `${b.id} at ${b.url}${b.name ? ` ('${b.name}')` : ""}`).join(", ");
  if (pool.length === 1) return pool[0] as DiscoveredBridge;
  if (pool.length === 0) {
    throw new DiscoveryError(
      wantedId
        ? `no Hue bridge with id ${wantedId} found on the network${bridges.length ? ` (found: ${list})` : ""}`
        : "no Hue bridge found on the network (tried mDNS and https://discovery.meethue.com). " +
            "Pass its address: ATTACH ... (bridge '192.168.1.20', ...), or set HUE_BRIDGE.",
    );
  }
  throw new DiscoveryError(
    `found ${pool.length} Hue bridges: ${list}. Pick one with bridge '<id or address>' in ATTACH or HUE_BRIDGE.`,
  );
}

const memoryCache = new Map<string, DiscoveredBridge[]>();

/**
 * Find the bridge to use. `wantedId` (a bridge id from the `bridge` option)
 * narrows the choice when several bridges answer.
 */
export async function discoverBridge(wantedId: string | null, opts: DiscoveryOptions = {}): Promise<DiscoveredBridge> {
  const env = opts.env ?? process.env;
  if ((env.HUE_DISCOVERY ?? "").toLowerCase() === "off") {
    throw new DiscoveryError(
      "no Hue bridge address given and discovery is off (HUE_DISCOVERY=off). Pass bridge '<address>' in ATTACH or set HUE_BRIDGE.",
    );
  }
  const scheme = env.HUE_DISCOVERY_SCHEME || "https";
  const cloudUrl = env.HUE_DISCOVERY_URL || DEFAULT_DISCOVERY_URL;
  const mdnsOn = (env.HUE_DISCOVERY_MDNS ?? "").toLowerCase() !== "off";
  const probe = opts.probe ?? probeBridge;
  const cacheFile = opts.cacheFile === undefined ? defaultCacheFile(env) : opts.cacheFile;
  const cacheKey = `${scheme}|${cloudUrl}|${mdnsOn ? "mdns" : "nomdns"}`;
  const fits = (bridges: DiscoveredBridge[]) =>
    wantedId ? bridges.some((b) => b.id === wantedId.toLowerCase()) : bridges.length === 1;

  // 1. Remembered bridges, re-confirmed (an address can change with DHCP).
  const remembered = memoryCache.get(cacheKey) ?? readCache(cacheFile, cacheKey);
  if (remembered.length) {
    const still = await confirm(
      remembered.map((b) => ({ host: new URL(b.url).hostname, port: Number(new URL(b.url).port) || null })),
      scheme,
      probe,
    );
    if (fits(still)) {
      memoryCache.set(cacheKey, still);
      return chooseBridge(still, wantedId);
    }
  }

  // 2. mDNS, then 3. the cloud endpoint.
  let found: DiscoveredBridge[] = [];
  if (mdnsOn) found = await confirm(await (opts.mdns ?? mdnsCandidates)(), scheme, probe);
  if (!fits(found)) {
    const cloud = await confirm(await (opts.cloud ?? (() => cloudCandidates(cloudUrl)))(), scheme, probe);
    const ids = new Set(found.map((b) => b.id));
    found = [...found, ...cloud.filter((b) => !ids.has(b.id))];
  }
  if (found.length) {
    memoryCache.set(cacheKey, found);
    writeCache(cacheFile, cacheKey, found);
  }
  const chosen = chooseBridge(found, wantedId);
  log.debug(`discovered Hue bridge ${chosen.id} at ${chosen.url}`);
  return chosen;
}
