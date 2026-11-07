<!-- managed-by: vgi-starters (edit upstream in shared/README.md.tmpl, then run tools/render.py) -->
<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB, written in TypeScript.</em></p>

# VGI Starter Worker — TypeScript

[![CI](https://github.com/Query-farm/vgi-starter-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-starter-typescript/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

[VGI](https://query.farm/vgi) lets DuckDB call functions that live in a separate
process: your code, in any language, exposed as ordinary SQL. This worker adds
three example functions that you rename and replace with your own:

| Function | Kind | Shows you how to |
|---|---|---|
| `greet(name)` / `greet(name, style)` | scalar | vectorize over a column, overload, constrain a constant |
| `sequence_table(count, step := 1)` | table | stream rows in batches, take named arguments |
| `fetch_items(base_url, page_size := 100)` | table | page through a REST API, retry, read a secret |

<!-- template-only:start -->
## Use this template

This repository is a **template**. Click **Use this template** on GitHub, or:

```bash
gh repo create my-org/weather-worker --template Query-farm/vgi-starter-typescript --private --clone
cd weather-worker
make init NAME=weather     # renames catalog, package, binary, env vars; removes this section
make check                 # lint + tests over every transport + metadata score
```

Prefer to work with an AI coding agent? `make init` first, then hand it
[AGENTS.md](AGENTS.md). See [Using with coding agents](#using-with-coding-agents).

Starters exist for [Python](https://github.com/Query-farm/vgi-starter-python),
[TypeScript](https://github.com/Query-farm/vgi-starter-typescript),
[Go](https://github.com/Query-farm/vgi-starter-go),
[Rust](https://github.com/Query-farm/vgi-starter-rust),
[Java](https://github.com/Query-farm/vgi-starter-java) and
[C#](https://github.com/Query-farm/vgi-starter-csharp). They are generated from
[Query-farm/vgi-starters](https://github.com/Query-farm/vgi-starters); send
changes there.
<!-- template-only:end -->

## Quick start

**Prerequisites:** [Bun](https://bun.sh) 1.3+ and [uv](https://docs.astral.sh/uv/) (it runs the SQL
test runner and the metadata checker).

```bash
make build
```

Then open DuckDB 2.0 or [Haybarn](https://query.farm/products/haybarn) and attach the
worker. `LOCATION` is the command DuckDB runs to start it; use an absolute path,
because a relative one resolves against DuckDB's working directory.

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'starter' (TYPE vgi, LOCATION '/abs/path/to/vgi-starter-typescript/bin/vgi-starter-worker');
```

**Haybarn 2.0** (`uvx haybarn-cli`):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'starter' (TYPE vgi, LOCATION '/abs/path/to/vgi-starter-typescript/bin/vgi-starter-worker');
```

Now call the functions:

```sql
SELECT starter.main.greet('Ada');                         -- Hi, Ada!
SELECT starter.main.greet('Ada', 'formal');               -- Good day, Ada.
SELECT * FROM starter.main.sequence_table(5, step := 2) ORDER BY n;
```

`fetch_items` pages through a REST API. Try it against the public demo API (25 fixed items):

```sql
SELECT category, count(*) AS items, round(avg(price), 2) AS avg_price
FROM starter.main.fetch_items('https://vgi-starter-api.query-farm.services/v1')
GROUP BY category ORDER BY category;
```

If an older cached extension misbehaves, refresh it with `FORCE INSTALL vgi FROM query_farm;`
(DuckDB) or `FORCE INSTALL vgi FROM community;` (Haybarn).

## Using it in a pipeline

Worker functions compose with everything else in DuckDB:

```sql
-- Materialize an API into a local table.
CREATE TABLE items AS SELECT * FROM starter.main.fetch_items('https://vgi-starter-api.query-farm.services/v1');

-- Join it with local files.
SELECT i.name, i.price, s.units
FROM items i JOIN 'sales.parquet' s ON s.item_id = i.id;

-- Call a scalar per row of another table.
SELECT customer, starter.main.greet(customer, 'formal') FROM read_csv('customers.csv');
```

## Project layout

```
src/
  worker.ts        # entry point: serves the catalog over stdio, --unix or --http
  catalog.ts       # assembles the catalog; add new functions to FUNCTIONS
  meta.ts          # catalog/schema metadata + helpers (objectTags, column)
  greet.ts         # scalar example (overloads, const param with choices)
  sequence.ts      # table function example (named args, streaming state)
  fetch_items.ts   # REST API table function (pagination, retries, secrets)
  cli.ts           # flag parsing: stdio / --unix / --http (PORT:<n>, /health)
  log.ts           # stderr logger
bin/               # vgi-starter-worker (what DuckDB launches) and run-recipe
tests/             # bun unit tests (worker subprocess + mock API)
test/sql/          # sqllogictest files run through DuckDB
test/mock_api/     # offline mock of the REST API used by tests
examples/          # recipes: pushdown, caching, catalog tables, aggregates, COPY …
ci/                # integration harness used by `make test-sql` and CI
scripts/           # vgi_template.py (init / template-diff)
vgi-agent-tests.yaml  # private graders for the agent test tasks
```

## Adding a function

1. Create `src/<name>.ts`. Copy the closest example: `greet.ts` for a scalar,
   `sequence.ts` for a generator, `fetch_items.ts` for an API.
2. Declare arguments: `params` + `argDocs` (scalars), or the ordered `parameters`
   list when a constant needs `choices`/`ge`/`le`. Table functions use `args`,
   `argDocs` and `argConstraints`; an argument listed in `argDefaults` becomes a
   named argument (`step := 2`), the others are positional.
3. Give it `description`, `tags: objectTags(...)` (from `src/meta.ts`) and
   `examples`.
4. Add it to `FUNCTIONS` in `src/catalog.ts`.

**Which kind of function?**

| You want to… | Use |
|---|---|
| compute one value per input row | a **scalar** function |
| return a set of rows from arguments (an API, a file, a generator) | a **table** function |
| transform or aggregate the rows of a query | a **table in-out** function or an **aggregate** |
| expose a fixed dataset by name (`SELECT * FROM starter.main.t`) | a **catalog table** |
| write data out to a file or service | `COPY … TO` with a copy function |
| accept `INSERT` / `UPDATE` / `DELETE` | a catalog table with insert/update/delete functions |

The [examples/](examples/) folder has a recipe for most of these. Writable tables are
covered in the TypeScript SDK's API reference (look for the table descriptor's
insert, update and delete functions).

## Secrets and configuration

`fetch_items` shows the recommended pattern. A bearer token comes from a DuckDB secret
when one exists, and from an environment variable otherwise:

```sql
CREATE SECRET (TYPE starter_api, TOKEN 'your-token');      -- per session, never logged
```

```bash
STARTER_API_TOKEN=your-token make run-http                # for servers and containers
```

Try it: the demo API's `/v1/auth` endpoint needs the published token `demo-token`.

```sql
SELECT count(*) FROM starter.main.fetch_items('https://vgi-starter-api.query-farm.services/v1/auth');   -- fails: HTTP 401
CREATE SECRET (TYPE starter_api, TOKEN 'demo-token');
SELECT count(*) FROM starter.main.fetch_items('https://vgi-starter-api.query-farm.services/v1/auth');   -- 25
```

Never bake credentials into the image or the source. If a function can't run without
real credentials, its examples can't execute in CI either. Set `execute: false` on the
metadata check for that worker (see `.github/workflows/ci.yml`), and add
`LINT_ARGS ?= --no-execute` to the Makefile so local runs match.

## Testing

```bash
make test-unit                 # fast TypeScript unit tests
make test-sql                  # test/sql/*.test through DuckDB (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

`test/sql/*.test` files are [sqllogictest](https://duckdb.org/docs/stable/dev/sqllogictest/intro)
scripts. `ci/run-integration.sh` runs them against your worker and fails on any
unexpected skip, so a broken transport can't hide behind a green run.
`fetch_items` is tested against `test/mock_api/server.py` so tests are fast and
offline.

**Testing against real data:** put live tests in their own `.test` file that starts with
`require-env STARTER_LIVE`. They run only when that variable is set. Add the skip reason
to `EXPECTED_SKIP_REASONS` in CI.

## Metadata and the quality score

DuckDB, agents and documentation tools discover your functions through their metadata:
titles, descriptions, argument docs, examples and keywords.
[vgi-lint](https://github.com/Query-farm/vgi-lint-check) checks it, and CI runs it on
every push. Its settings live in `vgi-lint.toml`, which `make lint-explain`,
`vgi-lint lint`, and CI all read. This template scores 100/100 with no findings.

```bash
make lint-explain                              # findings, each with its fix
make lint-explain LINT_ARGS="--format agent"   # the same, grouped for coding agents
make lint-ai                                   # optional: an agent must solve vgi-agent-tests.yaml
```

Each report also states an **assurance level**: how much was actually verified.

| Level | Reached when | Here |
|---|---|---|
| L1 structural | the static metadata is clean | workers that need real credentials (`execute: false` in CI) |
| L2 behavioural | the examples also run and return what they claim | **the CI gate** |
| L3 semantic | an agent solves the worker's own test tasks, and the docs are reviewed | `make lint-ai`, before publishing |

- **How strict.** Your copy fails on warnings (`fail_on = "warning"` in `vgi-lint.toml`).
  Raise it to `"info"` before you publish the worker for others.
- **The linter isn't pinned.** It tracks the current quality bar, so a new rule can flag
  metadata that passed yesterday. Fix it, or waive the finding.
- **Waivers.** If a finding is genuinely wrong for your worker, waive it in
  `vgi-lint.toml` with a `kind` and a `reason`.
- **Existing workers.** If you're adding this gate to a worker that already has
  findings, record them with `vgi-lint lint --baseline vgi-lint-baseline --update-baseline`
  and set `baseline` in `vgi-lint.toml`. After that, only new findings fail.

Metadata lives in `src/meta.ts` and the `tags`/`examples` of each function.

## Logging and debugging

stdout carries the Arrow protocol, so **never print to stdout**. Log to stderr instead.
Use `log` from `src/log.ts` (it writes to stderr); `--debug` or `--log-level debug` turns it up and also enables the SDK's own tracing (`VGI_DEBUG`).

- Under DuckDB (stdio/launch), worker stderr shows up in DuckDB's error messages and
  terminal.
- In Docker it goes to `docker logs`.
- `make debug` runs one query against the worker with debug logging on.

## Deploying

The same binary serves stdio (DuckDB starts it locally) or HTTP (you host it):

```bash
docker build -t weather-worker .
docker run -p 8000:8000 -e STARTER_API_TOKEN=... weather-worker   # health: GET /health
```

```sql
ATTACH 'starter' (TYPE vgi, LOCATION 'https://workers.example.com/starter');
```

Put hosted workers behind TLS and authentication. See
[authentication](https://query.farm/vgi/authentication) for bearer tokens and JWTs, and
[distributing a worker](https://query.farm/vgi/distributing-a-worker) for packaging.
Pass secrets with `-e` or your platform's secret manager.

## Releasing

Push a tag like `v0.1.0`. The release workflow compiles the worker with `bun build --compile` into a standalone executable for Linux (x86-64, arm64), macOS (arm64) and Windows (x86-64), and attaches the archives to the GitHub release. Users download one file and point `LOCATION` at it, with no Bun or `node_modules` on the host. Every artifact is signed with cosign and
carries SLSA build provenance. `ci/check-version.sh` makes sure the tag matches the
version in `package.json`.

## Using with coding agents

[AGENTS.md](AGENTS.md) is written for AI coding agents (Claude Code reads it via
`CLAUDE.md`; Codex, Cursor and others read it directly). It covers the commands, the
recipe for adding a function, the metadata checklist and the sharp edges. A good first
prompt:

> Read AGENTS.md. Replace `fetch_items` with `forecast(lat DOUBLE, lon DOUBLE)` that calls
> the Open-Meteo API. Include full metadata, a mock-server test and a `STARTER_LIVE` test.
> You're done when `make check` passes.

## Keeping up with the template

`make template-diff` shows what changed upstream (CI, docs, examples) since your copy was
made. Your copy records its template version in `.vgi-starter.json`.

## Learn more

- [What is VGI?](https://query.farm/vgi) · [Getting started](https://query.farm/vgi/getting-started) · [Building a worker](https://query.farm/vgi/building-a-worker)
- [TypeScript SDK docs](https://query.farm/vgi/docs/typescript/): [scalar tutorial](https://query.farm/vgi/docs/typescript/tutorial/scalar/), [table tutorial](https://query.farm/vgi/docs/typescript/tutorial/table/)
- [Distributing a worker](https://query.farm/vgi/distributing-a-worker) · [Choosing a language](https://query.farm/vgi/languages) · [llms.txt](https://query.farm/vgi/llms.txt)
- SDK source: [@query-farm/vgi](https://github.com/Query-farm/vgi-typescript) · RPC layer: [https://vgi-rpc-typescript.query.farm](https://vgi-rpc-typescript.query.farm)

## Support

Open an issue on this repository. For VGI itself, see [query.farm](https://query.farm).

## Authorship & license

The starter template is written by [Query.Farm](https://query.farm) and released under
the [BSD Zero Clause License](LICENSE) (0BSD). Use it for anything, with no attribution
required. Replace this section with your own license once the code is yours.
