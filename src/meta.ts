/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "starter";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-starter-typescript";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  { name: "text", title: "Text", description: "Functions that build or transform strings." },
  { name: "generators", title: "Generators", description: "Table functions that generate rows." },
  { name: "api", title: "REST APIs", description: "Table functions that read from HTTP APIs." },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

export const CATALOG_DOC_LLM =
  "An example VGI worker generated from the Query.Farm starter template. It shows the three " +
  "shapes most workers need: a vectorized scalar function (`greet`, with a one- and two-argument " +
  "overload), a deterministic table function with a named default argument (`sequence_table`), " +
  "and a table function that pages through a REST API with retries and an optional bearer token " +
  "taken from a DuckDB secret or an environment variable (`fetch_items`). Replace these with " +
  "your own functions; keep the metadata complete so agents can discover and call them.";

export const CATALOG_DOC_MD =
  "# VGI starter worker\n\n" +
  "**An example [VGI](https://query.farm/vgi) worker that brings custom functions into DuckDB " +
  "SQL.** It was generated from the Query.Farm starter template and is meant to be renamed and " +
  "rewritten: every function here demonstrates one pattern you will reuse.\n\n" +
  "- `greet(name)` and `greet(name, style)`: a vectorized scalar with an overload and a " +
  "constrained constant argument.\n" +
  "- `sequence_table(count, step := 1)`: a deterministic table function that streams its " +
  "output in batches.\n" +
  "- `fetch_items(base_url, page_size := 100)`: wraps a paginated REST API, retrying politely " +
  "and reading a bearer token from a DuckDB secret or the environment.\n\n" +
  "The worker speaks Apache Arrow to DuckDB over stdin/stdout, a Unix socket, or HTTP, so the " +
  "same code runs as a local subprocess or a hosted service. See the " +
  "[VGI documentation](https://query.farm/vgi/docs/) to learn more.";

export const SCHEMA_DOC_LLM =
  "The `main` schema holds the starter template's example functions, one per common worker " +
  "pattern. `greet(name)` and `greet(name, style)` are vectorized scalars: use them inside a " +
  "projection or predicate, one result per row; `style` is a constant that must be 'casual' or " +
  "'formal'. `sequence_table(count, step := 1)` is a deterministic table function that returns " +
  "`count` rows of `(n, squared)`; use it for demos, tests, and as a template for generators. " +
  "`fetch_items(base_url, page_size := 100)` reads every item from a paginated JSON REST API as " +
  "`(id, name, category, price)` rows, streaming one page per batch, retrying rate-limited " +
  "requests, and authenticating with a `starter_api` DuckDB secret or the `STARTER_API_TOKEN` " +
  "environment variable. Scalars cannot take named arguments; table functions can.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "The starter template's example functions, one per common worker pattern.\n\n" +
  "- **Scalars** answer one question per row and slot into a projection or predicate.\n" +
  "- **Table functions** return sets of rows, streamed to DuckDB in Arrow batches.\n" +
  "- **REST readers** page through an HTTP API and authenticate with a DuckDB secret.";

export const AGENT_TEST_TASKS = [
  { name: "formal_greeting", prompt: "Using the starter worker, greet the name 'Grace' formally." },
  {
    name: "sum_of_squares",
    prompt:
      "Using the starter worker, what is the sum of the squared column for the first 10 rows " +
      "of the sequence with the default step?",
  },
  {
    name: "stepped_sequence",
    prompt: "List the n values of a 4-row sequence that steps by 5, in ascending order.",
  },
  {
    name: "items_per_category",
    prompt:
      "The items API is running at https://vgi-starter-api.query-farm.services/v1. How many items does it have in each category?",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "VGI Starter Worker",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query.Farm",
  "vgi.copyright": "Copyright 2026 Query.Farm LLC",
  "vgi.keywords": keywordsArray("vgi, duckdb, starter template, example worker, rest api, table function"),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Starter Functions",
  domain: "examples",
  "vgi.keywords": keywordsArray("greeting, sequence, generator, rest api, pagination"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};
