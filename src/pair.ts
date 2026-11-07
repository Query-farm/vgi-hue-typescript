/**
 * Create a Hue application key: `make pair` (or `bun run src/pair.ts`).
 *
 * Finds the bridge (HUE_BRIDGE, else discovery), then asks it for a key once a
 * second until someone presses its round link button (up to 90 s). The key is
 * written to ~/.config/vgi-hue/app_key (mode 600) and never printed, so it
 * stays out of terminal scrollback. Use it with:
 *
 *   export HUE_APP_KEY=$(cat ~/.config/vgi-hue/app_key)
 *
 * All output goes to stderr.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverBridge } from "./discovery.ts";

const WAIT_SECONDS = 90;
const DEVICE_TYPE = "vgi-hue#duckdb";

const say = (msg: string) => process.stderr.write(`${msg}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function keyFile(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "vgi-hue", "app_key");
}

type PairReply = { success?: { username?: string }; error?: { type?: number; description?: string } }[];

async function requestKey(baseUrl: string): Promise<{ key?: string; waiting?: boolean; error?: string }> {
  const response = await fetch(`${baseUrl}/api`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ devicetype: DEVICE_TYPE }),
    signal: AbortSignal.timeout(5000),
    tls: { rejectUnauthorized: false },
  } as RequestInit);
  const reply = (await response.json()) as PairReply;
  const first = reply[0];
  if (first?.success?.username) return { key: first.success.username };
  if (first?.error?.type === 101) return { waiting: true }; // link button not pressed
  return { error: first?.error?.description ?? `unexpected reply (HTTP ${response.status})` };
}

async function main(): Promise<void> {
  const file = keyFile();
  if (existsSync(file) && !process.argv.includes("--force")) {
    say(`A key already exists at ${file}. Re-run with --force to create a new one.`);
    process.exit(0);
  }
  const explicit = process.env.HUE_BRIDGE?.trim();
  const baseUrl = explicit
    ? /^https?:\/\//i.test(explicit)
      ? explicit.replace(/\/+$/, "")
      : `https://${explicit}`
    : (await discoverBridge(null)).url;
  say(`Bridge: ${baseUrl}`);
  say(`Press the round link button on the bridge now (waiting up to ${WAIT_SECONDS} s)...`);
  for (let elapsed = 0; elapsed < WAIT_SECONDS; elapsed++) {
    const result = await requestKey(baseUrl);
    if (result.key) {
      mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${result.key}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      say(`Paired. App key saved to ${file} (not shown).`);
      say(`Use it with: export HUE_APP_KEY=$(cat ${file})`);
      return;
    }
    if (result.error) {
      say(`The bridge refused: ${result.error}`);
      process.exit(1);
    }
    await sleep(1000);
  }
  say("Timed out: the link button was not pressed.");
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    say(`Pairing failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
