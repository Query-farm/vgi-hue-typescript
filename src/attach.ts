/**
 * ATTACH options: `bridge` and `app_key`.
 *
 *   ATTACH 'hue' (TYPE vgi, LOCATION '/abs/path/bin/vgi-hue-worker',
 *                 bridge '192.168.1.20', app_key getenv('HUE_APP_KEY'));
 *
 * The catalog advertises both options so DuckDB validates them (and redacts
 * `app_key`, declared secret). Functions and the transaction hooks read them
 * with the SDK's `attachOptions()`: the SDK carries the options inside
 * `attach_opaque_data` itself and encrypts the secret `app_key` with a
 * worker-held key, so the app key is never in plaintext in any opaque value
 * on any transport, and this worker never packs options into its own attach
 * bytes. Either option may be omitted,
 * in which case the worker falls back to `HUE_BRIDGE` / `HUE_APP_KEY` from
 * its environment, and with no bridge at all it discovers one on the LAN
 * (see `resolveConnection` in hue.ts and discovery.ts).
 */

import {
  type AttachOptionSpec,
  attachOptions,
  bool,
  type CatalogAttachResult,
  ReadOnlyCatalogInterface,
  utf8,
} from "@query-farm/vgi";
import { type BridgeConnection, type BridgeOptions, resolveConnection } from "./hue.ts";
import { beginTransaction, commitTransaction, rollbackTransaction } from "./transactions.ts";

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
  {
    name: "transactional",
    description:
      "Stage light changes (UPDATE and the control functions) in DuckDB transactions and send " +
      "them at COMMIT; ROLLBACK discards them. Default " +
      "false: every change is sent as its statement runs.",
    type: bool,
    default: false,
  },
];

/** The bridge options among the supplied ATTACH options (trimmed; blanks dropped). */
export function bridgeOptionsFrom(options: Readonly<Record<string, unknown>> | undefined): BridgeOptions {
  const out: BridgeOptions = {};
  for (const key of ["bridge", "app_key"] as const) {
    const value = options?.[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  if (options?.transactional === true) out.transactional = true;
  return out;
}

/**
 * The ATTACH options of the attach a call or hook belongs to, read through the
 * SDK's accessor from the attach bytes it handed us. No attach (a call outside
 * one) means "no options".
 */
export function decodeAttachOptions(bytes: Uint8Array | null | undefined): BridgeOptions {
  if (!bytes) return {};
  return bridgeOptionsFrom(attachOptions(bytes));
}

/** The bridge connection for a function call, from its bind request. */
export function connectionFor(bindCall: { attach_opaque_data?: Uint8Array | null }): Promise<BridgeConnection> {
  return resolveConnection(decodeAttachOptions(bindCall.attach_opaque_data));
}

/** The descriptor catalog plus the `bridge` / `app_key` ATTACH options. */
export class HueCatalogInterface extends ReadOnlyCatalogInterface {
  override async attach(
    name: string,
    options?: Record<string, unknown>,
    dataVersionSpec?: string | null,
    implementationVersion?: string | null,
    clientCapabilities?: Uint8Array | null,
  ): Promise<CatalogAttachResult> {
    // The attach bytes stay the SDK's random per-attach id: the options reach
    // functions and hooks through attachOptions(), app_key encrypted.
    const result = await super.attach(name, options, dataVersionSpec, implementationVersion, clientCapabilities);
    return {
      ...result,
      // Only a transactional attach asks DuckDB for begin/commit/rollback.
      supports_transactions: options?.transactional === true,
    };
  }

  override transactionBegin(_attachOpaqueData: Uint8Array): Uint8Array {
    return beginTransaction();
  }

  override async transactionCommit(attachOpaqueData: Uint8Array, transactionOpaqueData: Uint8Array): Promise<void> {
    await commitTransaction(() => resolveConnection(decodeAttachOptions(attachOpaqueData)), transactionOpaqueData);
  }

  override transactionRollback(_attachOpaqueData: Uint8Array, transactionOpaqueData: Uint8Array): void {
    rollbackTransaction(transactionOpaqueData);
  }
}
