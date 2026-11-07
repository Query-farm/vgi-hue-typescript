/**
 * Recipe: let DuckDB cache an expensive result.
 *
 * The worker *advertises* how long a result stays fresh. DuckDB caches it, and
 * repeat queries inside the TTL never reach the worker. After the TTL, DuckDB
 * revalidates with an ETag; if nothing changed the worker answers "not
 * modified" with zero rows.
 *
 *   SELECT * FROM cache_expensive_call.main.exchange_rates();
 */

import {
  batchFromColumns,
  type CatalogDescriptor,
  cacheControlMetadata,
  defineTableFunction,
  field,
  float64,
  schema,
  utf8,
} from "@query-farm/vgi";

// In a real worker, derive this from the upstream: a Last-Modified header, a
// version column, a content hash. It is the only thing revalidation compares.
const DATA_VERSION = '"rates-v1"';
const RATES_SCHEMA = schema([field("currency", utf8()), field("rate", float64())]);
const ROWS = { currency: ["EUR", "GBP", "JPY"], rate: [1.09, 1.27, 0.0067] };

export const exchangeRates = defineTableFunction<Record<string, never>, { done: boolean }>({
  name: "exchange_rates",
  description: "Exchange rates from a slow upstream, cacheable for 5 minutes",
  onBind: () => ({ outputSchema: RATES_SCHEMA }),
  initialState: () => ({ done: false }),

  // Emit the rates with cache metadata, or confirm the client's copy is current.
  process: (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    state.done = true;
    if (params.ifNoneMatch === DATA_VERSION) {
      out.emit(
        batchFromColumns({ currency: [], rate: [] }, RATES_SCHEMA),
        cacheControlMetadata({ ttl: 300, etag: DATA_VERSION, revalidatable: true, notModified: true }),
      );
      return;
    }
    // Cache metadata must ride on the FIRST batch.
    out.emit(
      batchFromColumns(ROWS, RATES_SCHEMA),
      cacheControlMetadata({
        ttl: 300,
        etag: DATA_VERSION,
        revalidatable: true,
        staleWhileRevalidate: 60,
        staleIfError: 600,
      }),
    );
  },
});

export const catalog: CatalogDescriptor = {
  name: "cache_expensive_call",
  schemas: [{ path: ["main"], functions: [exchangeRates] }],
};
