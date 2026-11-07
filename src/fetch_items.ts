/**
 * Table function example: `fetch_items`, wrapping a paginated REST API.
 *
 * This is the pattern most workers start from: page through an HTTP API and
 * stream each page to DuckDB as one Arrow batch.
 *
 * - **Streaming.** `process` fetches one page per call and keeps the next page
 *   number in `FetchState`, so a 10,000-page API never sits in memory.
 * - **Politeness.** Requests time out, and 429/5xx responses are retried with
 *   backoff that honours `Retry-After`.
 * - **Credentials.** A bearer token comes from a DuckDB secret if one exists
 *   (`CREATE SECRET (TYPE starter_api, TOKEN '...')`), otherwise from the
 *   `STARTER_API_TOKEN` environment variable. The token is read from the
 *   secret on every call and never stored in state, because state can travel
 *   back to DuckDB over HTTP.
 *
 * The tests run against `test/mock_api/server.py`; point `base_url` at your
 * real API once you adapt the parsing in `parsePage`.
 */

import {
  batchFromColumns,
  defineTableFunction,
  field,
  float64,
  int64,
  type SecretTypeDescriptor,
  schema,
  secretsOfType,
  utf8,
} from "@query-farm/vgi";
import { log } from "./log.ts";
import { column, objectTags, VERSION } from "./meta.ts";

export const SECRET_TYPE = "starter_api";
export const TOKEN_ENV_VAR = "STARTER_API_TOKEN";
export const TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 4;
const USER_AGENT = `vgi-starter-worker/${VERSION}`;

/** Registered with DuckDB so users can run CREATE SECRET (TYPE starter_api, TOKEN '...'). */
export const API_SECRET_TYPE: SecretTypeDescriptor = {
  name: SECRET_TYPE,
  description: "Bearer token for the API that fetch_items reads.",
  schema: schema([field("token", utf8(), true, new Map([["redact", "true"]]))]),
};

export const ITEMS_SCHEMA = schema([
  column("id", int64(), "Item identifier assigned by the API.", false),
  column("name", utf8(), "Item display name."),
  column("category", utf8(), "Item category, e.g. 'hardware'."),
  column("price", float64(), "Item price in US dollars."),
]);

interface FetchArgs {
  base_url: string;
  page_size: bigint;
}

/** Cursor: the next page to request, or 0 once the API says there are no more. */
interface FetchState {
  nextPage: number;
}

export interface Item {
  id: number;
  name: string | null;
  category: string | null;
  price: number | null;
}

/** The API returned an error we will not retry. */
export class ApiError extends Error {}

/** Return the bearer token: DuckDB secret first, then the environment. */
export function resolveToken(secrets: Record<string, Record<string, unknown>>): string | undefined {
  for (const secret of secretsOfType(secrets, SECRET_TYPE)) {
    if (typeof secret.token === "string" && secret.token) return secret.token;
  }
  return process.env[TOKEN_ENV_VAR] || undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET `url` and decode JSON, retrying 429, 5xx and network errors with backoff. */
export async function getJson(url: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": USER_AGENT };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new ApiError(`GET ${url} failed: ${(err as Error).message}`);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (response.ok) return response.json();
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      const body = (await response.text()).slice(0, 500);
      throw new ApiError(`GET ${url} failed with HTTP ${response.status}: ${body}`);
    }
    await response.body?.cancel();
    const retryAfter = response.headers.get("Retry-After");
    const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 500 * 2 ** attempt;
    log.debug(`GET ${url}: HTTP ${response.status}, retrying in ${delay} ms`);
    await sleep(Math.min(delay, 30_000));
  }
}

/** Split one API response into rows and the next page number. Adapt this to your API. */
export function parsePage(body: unknown): { items: Item[]; nextPage: number | null } {
  const page = body as { items: Item[]; next_page?: number | null };
  return { items: page.items, nextPage: page.next_page ?? null };
}

/** Page through `<base_url>/items` and stream every item as a row. */
export const fetchItems = defineTableFunction<FetchArgs, FetchState>({
  name: "fetch_items",
  description: "Read every item from a paginated REST API, one page per batch",
  args: { base_url: utf8(), page_size: int64() },
  argDefaults: { page_size: 100 },
  argDocs: {
    base_url: "Root URL of the API, e.g. 'https://vgi-starter-api.query-farm.services/v1'.",
    page_size: "Items requested per page; 1 to 1000.",
  },
  argConstraints: { base_url: { pattern: "^https?://" }, page_size: { ge: 1, le: 1000 } },

  // Declare the output schema and ask DuckDB for the optional `starter_api`
  // secret. The first bind requests the lookup; the second receives it.
  onBind: (params) =>
    params.resolvedSecretsProvided
      ? { outputSchema: ITEMS_SCHEMA }
      : { outputSchema: ITEMS_SCHEMA, lookupSecretTypes: [SECRET_TYPE] },

  initialState: () => ({ nextPage: 1 }),

  // Fetch one page and emit it; finish when the API has no next page.
  process: async (params, state, out) => {
    if (state.nextPage === 0) {
      out.finish();
      return;
    }
    const query = new URLSearchParams({ page: String(state.nextPage), page_size: String(params.args.page_size) });
    const url = `${params.args.base_url.replace(/\/+$/, "")}/items?${query}`;
    const { items, nextPage } = parsePage(await getJson(url, resolveToken(params.secrets)));
    out.emit(
      batchFromColumns(
        {
          id: items.map((item) => BigInt(item.id)),
          name: items.map((item) => item.name ?? null),
          category: items.map((item) => item.category ?? null),
          price: items.map((item) => item.price ?? null),
        },
        params.outputSchema,
      ),
    );
    state.nextPage = nextPage ?? 0;
  },

  tags: {
    ...objectTags({
      title: "Fetch Items From API",
      category: "api",
      keywords: "rest api, http, pagination, fetch, items, json api, bearer token",
      docLlm:
        "Read all items from a paginated JSON REST API at `base_url` and return them as " +
        "rows `(id, name, category, price)`. Pages are requested `page_size` at a time " +
        "(named argument, default 100) and streamed to DuckDB as they arrive. If a " +
        "DuckDB secret of type `starter_api` exists its `token` is sent as a bearer " +
        "token; otherwise the `STARTER_API_TOKEN` environment variable is used. " +
        "Rate-limit (429) and server errors are retried with backoff.",
      docMd:
        "## fetch_items(base_url, page_size := 100)\n\n" +
        "Every item from a paginated REST API, streamed one page per batch.\n\n" +
        "Authenticate with a `starter_api` secret or the `STARTER_API_TOKEN` " +
        "environment variable:\n\n" +
        "```sql\nCREATE SECRET (TYPE starter_api, TOKEN 'your-token');\n```",
    }),
    "vgi.result_columns_schema": JSON.stringify([
      { name: "id", type: "BIGINT", description: "Item identifier assigned by the API." },
      { name: "name", type: "VARCHAR", description: "Item display name." },
      { name: "category", type: "VARCHAR", description: "Item category, e.g. 'hardware'." },
      { name: "price", type: "DOUBLE", description: "Item price in US dollars." },
    ]),
  },
  examples: [
    {
      sql:
        "SELECT id, name, price FROM starter.main.fetch_items('https://vgi-starter-api.query-farm.services/v1') " +
        "WHERE category = 'hardware' ORDER BY price DESC LIMIT 5",
      description: "The five priciest hardware items from the public demo API",
    },
    {
      sql:
        "SELECT category, count(*) AS items, avg(price) AS avg_price " +
        "FROM starter.main.fetch_items('https://vgi-starter-api.query-farm.services/v1', page_size := 10) " +
        "GROUP BY category ORDER BY category",
      description: "Summarize the API's items by category, ten per request",
    },
  ],
});
