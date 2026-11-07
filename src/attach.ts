/**
 * ATTACH options: `bridge` and `app_key`.
 *
 *   ATTACH 'hue' (TYPE vgi, LOCATION '/abs/path/bin/vgi-hue-worker',
 *                 bridge '192.168.1.20', app_key getenv('HUE_APP_KEY'));
 *
 * The catalog advertises both options so DuckDB validates them (and redacts
 * `app_key`, declared secret). At attach time the worker packs the supplied
 * values into the catalog's `attach_opaque_data`, which DuckDB hands back on
 * every function call. Over HTTP the SDK seals those bytes in an
 * authenticated-encrypted envelope bound to the caller; over stdio/unix they
 * never leave the worker's own process pair. Either option may be omitted,
 * in which case the worker falls back to `HUE_BRIDGE` / `HUE_APP_KEY` from
 * its environment, and with no bridge at all it discovers one on the LAN
 * (see `resolveConnection` in hue.ts and discovery.ts).
 */

import {
  type AttachOptionSpec,
  type CatalogAttachResult,
  type CatalogInfo,
  ReadOnlyCatalogInterface,
  serializeAttachOptionSpecs,
  utf8,
} from "@query-farm/vgi";
import { type BridgeConnection, type BridgeOptions, resolveConnection } from "./hue.ts";

export const ATTACH_OPTIONS: AttachOptionSpec[] = [
  {
    name: "bridge",
    description:
      "Hue bridge: an IP or host name (HTTPS is used), a full http(s):// URL, or a bridge id " +
      "to pick one of several. Defaults to the HUE_BRIDGE environment variable of the worker; " +
      "when neither is set the bridge is discovered on the local network (mDNS, then " +
      "discovery.meethue.com).",
    type: utf8(),
  },
  {
    name: "app_key",
    description:
      "Hue application key (the 'username' created by pressing the bridge's link button). " +
      "Defaults to the HUE_APP_KEY environment variable of the worker.",
    type: utf8(),
    secret: true,
  },
];

const MAGIC = "hue1:";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Pack the supplied ATTACH options into attach_opaque_data bytes. */
export function encodeAttachOptions(options: Record<string, unknown> | undefined): Uint8Array {
  const out: BridgeOptions = {};
  for (const key of ["bridge", "app_key"] as const) {
    const value = options?.[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return encoder.encode(MAGIC + JSON.stringify(out));
}

/** Unpack attach_opaque_data; anything unrecognised means "no options". */
export function decodeAttachOptions(bytes: Uint8Array | null | undefined): BridgeOptions {
  if (!bytes || bytes.length === 0) return {};
  const text = decoder.decode(bytes);
  if (!text.startsWith(MAGIC)) return {};
  try {
    return JSON.parse(text.slice(MAGIC.length)) as BridgeOptions;
  } catch {
    return {};
  }
}

/** The bridge connection for a function call, from its bind request. */
export function connectionFor(bindCall: { attach_opaque_data?: Uint8Array | null }): Promise<BridgeConnection> {
  return resolveConnection(decodeAttachOptions(bindCall.attach_opaque_data));
}

/** The descriptor catalog plus the `bridge` / `app_key` ATTACH options. */
export class HueCatalogInterface extends ReadOnlyCatalogInterface {
  override attachOptionSpecs(_name: string): AttachOptionSpec[] {
    return ATTACH_OPTIONS;
  }

  override catalogsInfo(): CatalogInfo[] {
    return super.catalogsInfo().map((info) => ({
      ...info,
      attach_option_specs: serializeAttachOptionSpecs(ATTACH_OPTIONS),
    }));
  }

  override async attach(
    name: string,
    options?: Record<string, unknown>,
    dataVersionSpec?: string | null,
    implementationVersion?: string | null,
    clientCapabilities?: Uint8Array | null,
  ): Promise<CatalogAttachResult> {
    const result = await super.attach(name, options, dataVersionSpec, implementationVersion, clientCapabilities);
    return { ...result, attach_opaque_data: encodeAttachOptions(options) };
  }
}
