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

import { field, schema, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "hue";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/your-org/vgi-hue";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  { name: "inventory", title: "Inventory", description: "Lights, rooms, zones and scenes on the bridge." },
  { name: "sensors", title: "Sensors", description: "Motion, temperature, light-level, contact and battery readings." },
  { name: "control", title: "Control", description: "Functions that change the state of real lights." },
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

/** [name, Arrow type, SQL type name, description, nullable?] for one result column. */
export type ResultColumn = [string, VgiDataType, string, string, boolean?];

/**
 * Declare a table function's result once: the Arrow schema it emits, its column
 * names, and the `vgi.result_columns_schema` tag that documents it.
 */
export function resultColumns(cols: ResultColumn[]) {
  return {
    schema: schema(cols.map(([name, type, , doc, nullable]) => column(name, type, doc, nullable ?? true))),
    names: cols.map(([name]) => name),
    tag: JSON.stringify(cols.map(([name, , sqlType, description]) => ({ name, type: sqlType, description }))),
  };
}

export const CATALOG_DOC_LLM =
  "Read and control Philips Hue smart lighting from SQL through a Hue bridge on the local " +
  "network (CLIP v2 API). Connect by passing the application key as the ATTACH option " +
  "`app_key`; the bridge is found automatically on the local network, or set the `bridge` " +
  "option to its address or bridge id (the worker's HUE_APP_KEY and HUE_BRIDGE environment " +
  "variables are fallbacks). Concepts: every light belongs to a physical device; " +
  "devices are placed in a room; a zone is any grouping of individual lights; a scene is a " +
  "saved lighting state for one room or zone; a sensor is a service on a device (a Hue motion " +
  "sensor also reports temperature, ambient light and battery). Inventory is exposed as " +
  "tables that always read live bridge state. Changes are made with table functions that send " +
  "a command when the query runs and return one row per change, matching targets by id or " +
  "case-insensitive name; brightness is a percentage and white temperature is in Kelvin. They " +
  "switch real lights in someone's home, so call them only when the user asks.";

export const CATALOG_DOC_MD =
  "# Philips Hue for DuckDB\n\n" +
  "**Query and control your Hue lights with SQL.** This [VGI](https://query.farm/vgi) worker " +
  "talks to a Hue bridge on your network: read the live state of every light, room, zone, " +
  "scene and sensor as tables, join it with anything else in DuckDB, and switch lights from a " +
  "query.\n\n" +
  "Attach it with an application key (created by pressing the bridge's link button); the " +
  "bridge itself is discovered on your network. Pass the key with `getenv(...)` to keep it out of your SQL; DuckDB " +
  "redacts it either way.";

export const SCHEMA_DOC_LLM =
  "Everything for the attached Hue bridge lives in `main`. The inventory tables take no " +
  "arguments and reflect the bridge at query time; filter and join them like any table. The " +
  "control functions take a target (id or case-insensitive name) plus named, optional state " +
  "arguments, at least one of which is required: `power := true|false` (on/off; `on` is a SQL " +
  "keyword), `brightness := 0..100` (above 0 implies on, 0 turns off), `kelvin := 2000..6500` " +
  "or `color := '#rrggbb'` (one or the other) and `transition_ms` (fade time). Each returns " +
  "rows of `target_type`, `target_id`, `name`, `ok`, `error`, `request`. For many lights at " +
  "once, feed a query that has a `light_id` column into the bulk function.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "Every table and function for the attached Hue bridge.\n\n" +
  "- **Inventory tables** show what exists and its live state.\n" +
  "- **Control functions** change a light, a room or zone, or recall a scene, and return " +
  "what they sent.";

export const AGENT_TEST_TASKS = [
  { name: "lights_on_per_room", prompt: "Using the hue worker, how many lights are on in each room?" },
  { name: "active_scenes", prompt: "Using the hue worker, which scene is currently active in each room?" },
  { name: "biggest_room", prompt: "Using the hue worker, which room has the most lights?" },
  {
    name: "warmest_room",
    prompt: "Using the hue worker, which room has the highest temperature sensor reading?",
  },
  { name: "kitchen_off", prompt: "Using the hue worker, turn off all the lights in the Kitchen." },
  { name: "dim_sofa", prompt: "Using the hue worker, set the Sofa lamp to 30% brightness." },
  {
    name: "relax_living_room",
    prompt: "Using the hue worker, activate the Relax scene in the Living room.",
  },
  {
    name: "warm_white_everywhere",
    prompt: "Using the hue worker, set every light that supports colour temperature to 2700 K.",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "VGI Hue Worker",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query.Farm",
  "vgi.copyright": "Copyright 2026 Query.Farm LLC",
  "vgi.keywords": keywordsArray("philips hue, smart home, lights, home automation, sensors, duckdb, vgi"),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Hue Functions",
  domain: "smart home",
  "vgi.keywords": keywordsArray("hue, lights, rooms, scenes, sensors, light control"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};
