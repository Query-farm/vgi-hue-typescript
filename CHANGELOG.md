# Changelog

## 0.1.0 (unreleased)

Initial worker generated from the VGI starter template.

- Colours by CIE xy, gradients and effects on `hue.main.lights`:
  - `color_x` / `color_y` are updatable: the xy is sent as is (no hex round trip); setting one
    keeps the light's current value for the other. Refused before anything is sent: together
    with `color_hex`, outside 0–1, or on a light without colour. RETURNING shows the requested
    xy (the bridge may clamp it to the lamp's gamut).
  - New columns `gradient_hex` (`VARCHAR[]`), `gradient_xy` (`STRUCT(x DOUBLE, y DOUBLE)[]`),
    `gradient_mode` (all updatable), `gradient_points_capable`, `gradient_pixel_count`
    (read-only), and `effect` (updatable; `'no_effect'` when none). NULL for lights without a
    gradient / effects. Writes are validated against the light's points_capable, mode_values and
    effect_values; a gradient and a single colour in one statement are refused. `gradient_mode`
    alone re-sends the current points (CLIP v2 needs them).
  - New table function `set_gradient(light, colors, mode := 'interpolated_palette')`, returning
    the same rows as `set_light`.
  - A gradient needs at least 2 points (the real bridge refuses 0 or 1 with HTTP 207 "invalid
    attribute value (.gradient.points)"): UPDATE and `set_gradient` now refuse fewer than 2 before
    anything is sent ("light '<name>' takes 2–<max> gradient points, got <n>"), and so does the mock
    (HTTP 400). After a gradient write the bridge sets the light's colour to the first point:
    RETURNING now reports `color_mode` 'xy' with `color_x`/`color_y`/`color_hex` from that point,
    and the mock does the same so a re-read matches.
  - `set_gradient` with no colours now says "set_gradient needs at least two colours", and
    `gradient_mode` alone on a light with fewer than 2 current points (also counting staged changes) is refused before any PUT ("light '<name>' has no gradient to change the mode of; set gradient_hex or gradient_xy too").
  - All of it stages and replays at COMMIT in a transactional attach. Coalescing drops a staged
    gradient when a colour follows (and vice versa); a failed commit also restores gradients and
    effects. `UPDATE` now compares SET values with the rows as the transaction sees them.
  - Mock bridge: a gradient lightstrip "Hallway strip" (`l-strip`, 5 points, 10 pixels, four
    modes) in the Hallway, `effects` on the colour lights, and bridge-like HTTP 400s for invalid
    gradient, effect and xy PUTs. Existing SQL expectations were updated for the extra light.

- Light PUTs are pipelined: `UPDATE hue.main.lights` and `COMMIT` of a transactional attach
  start requests on the same pace slots as before (100 ms apart for lights, 1 s for room and
  scene commands) but keep up to `MAX_IN_FLIGHT` = 4 in flight instead of waiting for each
  response (`putAll` in `src/hue.ts`). Requests to the same light stay in order; a room or
  scene command runs alone, after everything before it. On the first refusal nothing new starts,
  in-flight requests finish, and the first error is raised as before. `pace` now books its slot
  before sleeping, so concurrent callers stay spaced out. The UPDATE sends all its rows' requests
  in one batch. Against the mock bridge with 300 ms per PUT, 12 lights went from 3.6 s to 1.4 s.
  The mock bridge gained `MOCK_LIGHT_DELAY_MS`, `MOCK_EXTRA_LIGHTS`, `MOCK_FAIL_LIGHT` and a
  `GET /debug/puts` request log (all off by default).

- Requires `@query-farm/vgi` 0.50.0 (protocol vgi.v3 3.3.0; the DuckDB vgi extension now
  rejects 3.2 workers with "server is too old").
  Under 3.3 the tables' scans (`lights_scan`, `rooms_scan`, ...) and `lights_update` are listed
  `table_only`: DuckDB still uses them for the tables (projection pushdown for `rowid`, so
  UPDATE works) but they are no longer SQL functions. `duckdb_functions()` for the catalog now
  lists only `recall_scene`, `set_light`, `set_lights` and `set_room`, the same in every port;
  `hue.test` checks this and that calling a scan or `lights_update` directly fails.
  `lights_scan` is no longer listed in the schema's `functions` (that made it a public
  function; the SDK now sends every table's scan itself), and its `lights_scan()` example is gone.
  No `exposeScan`: nothing calls the scan directly.

- Requires `@query-farm/vgi` 0.49.1 (protocol vgi.v3 3.2.0; the DuckDB vgi extension now
  rejects 3.1 workers) and `@query-farm/vgi-rpc` 0.29.7. The `pushdown_sqlite` recipe sets
  `autoApplyFilters`: DuckDB does not re-check pushed predicates, so `NOT IN` / `NOT LIKE`
  used to return every row.

- `app_key` (and `bridge`, `transactional`) reach functions and transaction hooks only
  through `@query-farm/vgi` 0.48.5's `attachOptions()`; the SDK encrypts the secret app key
  inside `attach_opaque_data`, so it is never in plaintext in the attach bytes.
- `ci/run-integration.sh` gives every SQL test file a fresh mock bridge (and a fresh HTTP
  worker / launcher pool), so files cannot leak bridge state into each other.

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
