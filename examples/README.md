<!-- managed-by: vgi-starters (edit upstream in shared/examples/README.md.tmpl) -->
# Recipes

Small, complete workers, one per pattern. Each runs on its own and is tested by
`examples/test/recipes.test` (`make test-sql`). Copy the pattern you need into the
main worker.

| Recipe | Pattern | Try it |
|---|---|---|
| `transform_rows` | table in-out: transform the rows of a query | `SELECT * FROM transform_rows.main.positive_only((SELECT * FROM t))` |
| `aggregate` | aggregate with per-group state | `SELECT k, aggregate.main.int_sum(v) FROM t GROUP BY k` |
| `pushdown_sqlite` | filter + projection pushdown into a database | `SELECT id FROM pushdown_sqlite.main.orders() WHERE region = 'west'` |
| `cache_expensive_call` | let DuckDB cache a slow result (TTL + ETag) | `SELECT * FROM cache_expensive_call.main.exchange_rates()` |
| `catalog_tables` | a dataset queried by name, with a primary key | `SELECT * FROM catalog_tables.main.countries` |
| `copy_to_sink` | `COPY … TO` with a custom output format | `COPY t TO 'out.jsonl' (FORMAT 'copy_to_sink.jsonl_out')` |

Streaming large results and calling REST APIs are covered by the main worker's
`sequence_table` and `fetch_items`.

## Running a recipe

```sql
ATTACH 'aggregate' (TYPE vgi, LOCATION '/abs/path/bin/run-recipe aggregate');
```

`bin/run-recipe <recipe>` (a wrapper for `bun run examples/run.ts <recipe>`) serves one recipe. Recipes import only `@query-farm/vgi`,
Bun built-ins (`bun:sqlite`) and the shared CLI in `src/cli.ts`.

The recipes are deliberately small and skip the full metadata the main worker carries.
Add it when you move a pattern into your worker.
