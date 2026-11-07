<!-- managed-by: vgi-starters (edit upstream in shared/AGENTS.md.tmpl, then run tools/render.py) -->
# AGENTS.md: working on this VGI worker

This repository is a **VGI worker** written in TypeScript. DuckDB starts it (or connects
to it over HTTP) and calls its functions from SQL; data moves as Apache Arrow
batches. Background reading, in order of usefulness:

1. https://query.farm/vgi/llms.txt — index of all VGI docs, written for agents
2. https://query.farm/vgi/docs/typescript/ — the TypeScript SDK (@query-farm/vgi)
3. https://query.farm/vgi/building-a-worker — concepts: catalogs, schemas, function kinds

## Definition of done

**`make check` passes.** It runs formatting and static checks, unit tests, the SQL
tests over the stdio, launch and http transports, and the metadata quality check
(vgi-lint, at the `fail_on` level in `vgi-lint.toml`). Don't hand work back until it passes. If a
check is wrong, fix the check and say why. Never delete a test to get green.

Faster loops while iterating: `make test-unit`, `make test-sql`, `make lint-explain`.

## Layout

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

## Recipe: add a function

1. Create `src/<name>.ts`. Copy the closest example: `greet.ts` for a scalar,
   `sequence.ts` for a generator, `fetch_items.ts` for an API.
2. Declare arguments: `params` + `argDocs` (scalars), or the ordered `parameters`
   list when a constant needs `choices`/`ge`/`le`. Table functions use `args`,
   `argDocs` and `argConstraints`; an argument listed in `argDefaults` becomes a
   named argument (`step := 2`), the others are positional.
3. Give it `description`, `tags: objectTags(...)` (from `src/meta.ts`) and
   `examples`.
4. Add it to `FUNCTIONS` in `src/catalog.ts`.

Then, for every new function:

1. **Metadata** (`src/meta.ts` and the `tags`/`examples` of each function): title, category from the schema's category list,
   keywords, `doc_llm` (for agents: what it does, arguments, when to use it) and `doc_md`
   (for humans). Describe each argument, and for table functions describe the result
   columns. Add 1–2 `examples` with fully qualified, analytical SQL
   (`starter.main.fn(...)`): project, filter or aggregate rather than `SELECT *`.
2. **Executable examples:** if the function is deterministic and needs no network,
   add an `executable_examples` entry with `ORDER BY` and an `expected_result`.
3. **SQL test:** add cases to `test/sql/starter.test`, or a new `test/sql/<name>.test`
   with the same header (`require vgi`, `require-env STARTER_WORKER`, then `ATTACH`).
   Avoid expected-error text that depends on SDK wording; use `<REGEX>:.*` for errors you
   don't control.
4. **Unit test** for any non-trivial logic.
5. **Agent task:** add a `{name, prompt}` to the catalog's agent test tasks, and its
   grader (`reference_sql` or `check_sql`) to `vgi-agent-tests.yaml`.
6. Run `make check`.

## Passing the metadata check

`make lint-explain` runs [vgi-lint](https://github.com/Query-farm/vgi-lint-check) against
the built worker with the settings in `vgi-lint.toml`. The linter isn't pinned, so new
rules arrive on their own. When it reports findings:

1. Run `make lint-explain LINT_ARGS="--format agent"`. Findings are grouped by rule:
   each rule's fix is stated once, followed by every object it applies to.
2. For a rule you don't understand, run
   `uvx --prerelease=allow --from 'vgi-lint-check>=2,<3' vgi-lint explain VGI123`.
   For tag names and value shapes, read `vgi-lint spec` rather than guessing.
3. Fix errors first, then warnings, then info. Fix the metadata in the worker, never
   the linter's settings.
4. If a finding is genuinely wrong for this worker, waive it in `vgi-lint.toml` with a
   `kind` and a `reason` (see the comments there). Never add an unexplained `ignore`.

The check executes examples (assurance level L2). `make lint-ai` adds L3: an agent must
solve the tasks in `vgi-agent-tests.yaml` using only the metadata, and the docs are
reviewed. It's optional, so run it before publishing.

## Choosing the function kind

| Need | Kind |
|---|---|
| one value per input row | scalar |
| rows from arguments (API, file, generator) | table function |
| transform the rows of a subquery | table in-out function |
| combine many rows into one value | aggregate |
| a fixed dataset referenced by name | catalog table |
| write data out to a file or service | `COPY … TO` copy function |
| accept INSERT / UPDATE / DELETE | catalog table with insert/update/delete functions (see the SDK API reference) |

Recipes for most kinds are in `examples/`.

## Sharp edges (read before writing code)

- **Never write to stdout.** stdout is the Arrow protocol channel, and one stray print
  corrupts the stream. Log to stderr. Use `log` from `src/log.ts` (it writes to stderr); `--debug` or `--log-level debug` turns it up and also enables the SDK's own tracing (`VGI_DEBUG`).
- **Scalars have no named arguments.** For an optional scalar argument, add an overload
  (a second function with the same SQL name and one more argument). Named arguments
  (`step := 2`) work on table functions only.
- **Declared constraints aren't a guarantee.** `choices`, `ge`, `le` and `pattern` are
  published so DuckDB and agents can discover them, but SDKs differ in which ones they
  enforce: some skip named table arguments, C# enforces none, and `pattern` matching
  differs (Java requires a full match). Where its SDK doesn't enforce a constraint, the
  starter re-checks it in bind code. Do the same, and on a columnar scalar argument validate
  values in the compute body.
- **Reserved argument names.** DuckDB keywords such as `interval`, `end`, `from`, `order`
  and `table` break `name := value` syntax. Pick another name (`start_date`, `end_date`).
- **State must be serializable.** Table-function state (`initialState`/`process`) must be a plain object of numbers, bigints, strings, booleans, arrays or nested plain objects (no `Date`, `Map` or class instances): the SDK infers an Arrow schema for it and serializes it. Over HTTP each batch can be served by a different process, so the cursor travels with the request. Keep it small, and never put secrets in it.
- **Examples must be deterministic.** Add `ORDER BY`, and no `now()`, random values or
  network. Examples that hit a live API go in `examples`, not `executable_examples`.
- **Credentials.** Read them from a DuckDB secret first (`CREATE SECRET (TYPE starter_api, …)`),
  then from an environment variable. Never put them in logs, examples or the repo, and
  keep them out of table-function state unless the state rule above says
  the SDK encrypts it. Workers that need real credentials set `execute: false` on the metadata check.
- **Errors.** Raise errors with a clear message. For HTTP failures, include the status
  code. DuckDB shows the message to the user.
- **Rate limits.** Retry 429 and 5xx with backoff, honour `Retry-After`, and set timeouts on
  every request.
- **Version pins.** Don't bump the @query-farm/vgi minor version by hand. A minor release can
  change the wire protocol, which must match the DuckDB extension exactly. Template
  updates (`make template-diff`) carry tested bumps.

## Language notes (TypeScript)

- Scalars receive a whole Arrow batch. Read argument columns by position
  (`batch.getChildAt(0)`), return one value per row (`null` for NULL), and keep the
  per-row work allocation-free.
- `BIGINT` arrives as `bigint`, never `number`; convert with `Number(...)` only when
  the value is known to fit (counts, page sizes).
- Table functions declare their output with `onBind: () => ({ outputSchema })` and
  emit `batchFromColumns(columns, params.outputSchema)`, so column types match what
  was bound (and projection pushdown is applied for you). Call `out.finish()` when done.
- Use `column(name, type, comment)` from `src/meta.ts` for output fields. The comment
  becomes the column description in DuckDB and agent tools.
- Secrets: return `lookupSecretTypes: ["<type>"]` from the first `onBind` (when
  `params.resolvedSecretsProvided` is false), then read them with
  `secretsOfType(params.secrets, "<type>")` in `process`.
- HTTP calls: global `fetch` with `AbortSignal.timeout(...)`; no HTTP client
  dependency needed.
- Dependencies go in `package.json`; run `bun install` and commit `bun.lock`. Keep
  them few: every dependency ships to every user of the worker.
- `strict` plus `noUncheckedIndexedAccess` is on (needs `@query-farm/vgi` 0.48.1+).
- Test clients: pass `int64: "bigint"` to `tableFunctionRows` so BIGINT columns are
  always `bigint`. The default returns a `number` when the value is small enough and
  a `bigint` otherwise.
- Gates: `biome format`, `biome lint`, `tsc --noEmit` (strict).

## Useful prompts

- "Add a scalar `slugify(text VARCHAR) -> VARCHAR` with full metadata and tests."
- "Replace `fetch_items` with a table function for <API>. Map its JSON to typed columns,
  read the token from a `starter_api` secret, and add mock-server tests."
- "Add a catalog table `countries` (code, name) with a primary key, following
  `examples/catalog_tables`."
