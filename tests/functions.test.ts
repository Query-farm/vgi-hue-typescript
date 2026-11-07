// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Arguments, VgiClient } from "@query-farm/vgi";
import { subprocessConnect } from "@query-farm/vgi-rpc";
import { getJson, parsePage, resolveToken } from "../src/fetch_items.ts";
import { greetAll } from "../src/greet.ts";
import { sequenceColumns } from "../src/sequence.ts";

const ROOT = join(import.meta.dir, "..");

test("greet: casual and formal, NULL stays NULL", () => {
  const names = ["Ada", null, "Grace"];
  expect(greetAll(names, "casual")).toEqual(["Hi, Ada!", null, "Hi, Grace!"]);
  expect(greetAll(names, "formal")).toEqual(["Good day, Ada.", null, "Good day, Grace."]);
});

test("sequence: columns for a window of rows", () => {
  expect(sequenceColumns(2, 3, 5n)).toEqual({ n: [10n, 15n, 20n], squared: [100n, 225n, 400n] });
});

test("fetch_items: token comes from the secret, then the environment", () => {
  const saved = process.env.STARTER_API_TOKEN;
  process.env.STARTER_API_TOKEN = "from-env";
  try {
    expect(resolveToken({ my_secret: { type: "starter_api", token: "from-secret" } })).toBe("from-secret");
    expect(resolveToken({})).toBe("from-env");
  } finally {
    if (saved === undefined) delete process.env.STARTER_API_TOKEN;
    else process.env.STARTER_API_TOKEN = saved;
  }
});

test("fetch_items: parsePage reads items and next_page", () => {
  const body = { items: [{ id: 1, name: "a", category: "c", price: 1.5 }], next_page: null };
  expect(parsePage(body)).toEqual({ items: body.items, nextPage: null });
});

describe("against the worker and the mock API", () => {
  let client: VgiClient;
  let mock: ReturnType<typeof Bun.spawn>;
  let mockUrl: string;

  beforeAll(async () => {
    // A client that launches the worker as a subprocess, the way DuckDB does.
    client = new VgiClient(subprocessConnect([process.execPath, "run", join(ROOT, "src", "worker.ts")]));
    // The mock API prints PORT:<n> once it is listening.
    mock = Bun.spawn([process.env.PYTHON ?? "python3", join(ROOT, "test", "mock_api", "server.py")], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const port = text.match(/^PORT:(\d+)/)?.[1];
    if (!port) throw new Error(`mock API did not report a port: ${text}`);
    mockUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    client?.close();
    mock?.kill();
  });

  async function table(name: string, positional: unknown[], named: Record<string, unknown> = {}) {
    const rows: Record<string, unknown>[] = [];
    for await (const page of client.tableFunctionRows({
      functionName: name,
      arguments: new Arguments(positional, new Map(Object.entries(named))),
      int64: "bigint",
    })) {
      rows.push(...page);
    }
    return rows;
  }

  // `int64: "bigint"` makes every BIGINT a bigint (the default mixes number and
  // bigint by size); convert to numbers to compare against small literals.
  const col = (rows: Record<string, unknown>[], name: string) => rows.map((r) => Number(r[name]));

  test("sequence_table: default step", async () => {
    const rows = await table("sequence_table", [4n]);
    expect(col(rows, "n")).toEqual([0, 1, 2, 3]);
    expect(col(rows, "squared")).toEqual([0, 1, 4, 9]);
  });

  test("sequence_table: named step", async () => {
    const rows = await table("sequence_table", [3n], { step: 5n });
    expect(col(rows, "n")).toEqual([0, 5, 10]);
  });

  test("sequence_table: streams in batches", async () => {
    const rows = await table("sequence_table", [25_000n]);
    expect(rows.length).toBe(25_000);
    expect(col(rows, "n").at(-1)).toBe(24_999);
  });

  test("fetch_items: pages through the API", async () => {
    const rows = await table("fetch_items", [mockUrl], { page_size: 4n });
    expect(rows.length).toBe(25);
    expect(col(rows, "id")).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(new Set(rows.map((r) => r.category))).toEqual(new Set(["hardware", "software", "service"]));
  });

  test("fetch_items: rejects a non-http URL at bind", async () => {
    await expect(table("fetch_items", ["ftp://example.com"])).rejects.toThrow(/pattern/i);
  });

  test("getJson: error names the HTTP status", async () => {
    await expect(getJson(`${mockUrl}/nope`)).rejects.toThrow(/HTTP 404/);
  });
});
