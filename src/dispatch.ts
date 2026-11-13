/**
 * Where a light change goes: to the bridge now, or into the current
 * transaction (transactional attaches; see transactions.ts).
 */

import { decodeAttachOptions } from "./attach.ts";
import { type BridgeConnection, putAll } from "./hue.ts";
import { type StagedRequest, stage, stageable } from "./transactions.ts";

/** Send (or stage) requests; resolves to which of the two happened. */
export type Sender = (requests: StagedRequest[]) => Promise<"sent" | "staged">;

/**
 * Send at once: paced as Hue asks (~10 light / ~1 group command per second)
 * and pipelined, up to MAX_IN_FLIGHT at a time (see putAll in hue.ts).
 */
export function immediate(conn: BridgeConnection): Sender {
  return async (requests) => {
    await putAll(conn, requests);
    return "sent";
  };
}

/** The sender for a function call: staged inside a transactional attach's transaction. */
export function senderFor(
  bindCall: { attach_opaque_data?: Uint8Array | null; transaction_opaque_data?: Uint8Array | null },
  conn: BridgeConnection,
): Sender {
  const txId = stageable(
    decodeAttachOptions(bindCall.attach_opaque_data).transactional === true,
    bindCall.transaction_opaque_data,
  );
  if (!txId) return immediate(conn);
  return async (requests) => {
    stage(txId, requests);
    return "staged";
  };
}
