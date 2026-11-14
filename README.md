# vgi-hue: Philips Hue lights in DuckDB

A [VGI](https://query.farm/vgi) worker, written in TypeScript, that lets DuckDB read and
control Philips Hue lights through a Hue bridge (CLIP v2 API). The live state of every
light, room, zone, scene and sensor is a table, and changing lights is a query.

```sql
SELECT room, count(*) FILTER (WHERE is_on) AS lit FROM hue.main.lights GROUP BY room;
SELECT * FROM hue.main.set_room('Kitchen', power := false);
```

## Quick start

**Prerequisites:** [Bun](https://bun.sh) 1.3+ and [uv](https://docs.astral.sh/uv/).

```bash
make build
```

### 1. Create an application key

You don't need the bridge's IP for the worker itself: it discovers the bridge. To create a
key, find the IP once with `curl -s https://discovery.meethue.com` (or in the Hue app under
Settings → Bridges), then **press the round link button on the bridge** and, within 30
seconds, run:

```bash
curl -k -X POST https://<bridge-ip>/api -d '{"devicetype":"vgi-hue#duckdb"}'
# [{"success":{"username":"AbCdEf..."}}]   <- this "username" is your app key
export HUE_APP_KEY=AbCdEf...
```

### 2. Attach it

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;

ATTACH 'hue' (TYPE vgi, LOCATION '/abs/path/to/hue-worker/bin/vgi-hue-worker',
              app_key getenv('HUE_APP_KEY'));
```

**Haybarn 2.0** (`uvx haybarn-cli`): `INSTALL vgi FROM community; LOAD vgi;`, then the same `ATTACH`.

`app_key` is declared secret, so DuckDB shows it as `<redacted>` in `duckdb_databases()`;
`getenv` keeps it out of your SQL text and history too.

| Option | Meaning | Fallback |
|---|---|---|
| `app_key` | Hue application key (secret, redacted) | `HUE_APP_KEY` env var of the worker |
| `transactional` | Optional, default `false`: stage light changes and send them at `COMMIT` (see [Transactions](#transactions)) | — |
| `bridge` | Optional: bridge IP or host name (HTTPS is used), a full `http(s)://` URL, or a bridge id (16 hex digits) to pick one of several bridges | `HUE_BRIDGE` env var, then discovery |

### Bridge discovery

With no `bridge`, the worker finds the bridge itself, in this order:

1. The bridge it found last time (cached in `~/.cache/vgi-hue/bridges.json`), if it still
   answers. This also follows a bridge whose DHCP address changed.
2. mDNS (`_hue._tcp.local`) on your LAN, which works without internet access.
3. Signify's `https://discovery.meethue.com`, which lists bridges that recently checked in
   from your public IP.

Each candidate is confirmed via the bridge's `/api/config`. With several bridges, the error
lists them; pick one with `bridge '<id or address>'`. Set `HUE_DISCOVERY=off` to require an
explicit address, or `HUE_DISCOVERY_MDNS=off` to skip mDNS.

The bridge's certificate is signed by Signify's private CA, so the worker does not verify
it; use it only on a network you trust. `LOCATION` must be an absolute path.

## Reading

| Table | One row per |
|---|---|
| `hue.main.lights` | light: `light_id`, `name`, `room`, `archetype`, `is_on`, `brightness` (0–100), `color_mode`, `color_temperature_kelvin`, `color_x`/`color_y`, `color_hex`, `gradient_hex`, `gradient_xy`, `gradient_mode`, `gradient_points_capable`, `gradient_pixel_count`, `effect`, `reachable`, `product_name`, `model_id`, `device_id` |
| `hue.main.rooms` | room or zone: `room_id`, `name`, `kind`, `archetype`, `grouped_light_id`, `any_on`, `brightness`, `light_count`, `light_names` |
| `hue.main.scenes` | scene: `scene_id`, `name`, `room`, `room_id`, `active` |
| `hue.main.sensors` | sensor reading (none shown for a disabled sensor): `kind` ∈ motion / temperature / light_level / contact / device_power, with `motion`, `temperature_c`, `light_level_lux`, `contact`, `battery_percent`, `battery_state`, `reachable`, `last_changed` |

```sql
-- Lights the bridge cannot reach (switched off at the wall?)
SELECT name, room FROM hue.main.lights WHERE NOT reachable;

-- Average temperature per room, and batteries that need replacing
SELECT room, round(avg(temperature_c), 1) FROM hue.main.sensors WHERE kind = 'temperature' GROUP BY room;
SELECT device_name, battery_percent FROM hue.main.sensors WHERE kind = 'device_power' AND battery_percent < 20;
```

Every query reads the bridge live. Nothing is cached.

## Changing lights with UPDATE

The `lights` table is writable. `WHERE` picks the lights; `SET` says what to change:

```sql
UPDATE hue.main.lights SET is_on = true, brightness = 40 WHERE room = 'Kitchen';
UPDATE hue.main.lights SET color_hex = '#ff8000' WHERE name LIKE 'Signe%' RETURNING name, color_hex;
UPDATE hue.main.lights SET color_temperature_kelvin = 2700 WHERE color_mode IS NOT NULL;
UPDATE hue.main.lights SET name = 'Reading lamp' WHERE name = 'Desk lamp';
```

| Updatable column | Values |
|---|---|
| `is_on` | `true` / `false` |
| `brightness` | 0–100 (above 0 turns the light on unless `is_on` says otherwise; 0 turns it off) |
| `color_temperature_kelvin` | 2000–6500 |
| `color_hex` | `'#rrggbb'`, `'#rgb'` or a basic colour name |
| `color_x`, `color_y` | CIE 1931 xy, each 0–1; sent as is (see [Colours](#colours-hex-or-xy)) |
| `gradient_hex`, `gradient_xy` | the points of a gradient light (see [Gradients](#gradients)) |
| `gradient_mode` | one of the light's gradient modes |
| `effect` | one of the light's effects; `'no_effect'` stops it (see [Effects](#effects)) |
| `name` | 1–32 characters; renames the light on the bridge |

Every other column belongs to the bridge or the device, and changing it is refused before
anything is sent. Each light gets one command (a rename with a state change gets two). `RETURNING` shows
the rows as written. Each light has a stable `rowid`, a hash of its id, which is how DuckDB
tells the worker which lights matched.

### Colours: hex or xy

A colour light has two views of its colour. `color_hex` is the friendly one: SET it to
`'#rrggbb'` (or `'red'`, `'orange'`, ...) and the worker converts it to the CIE 1931 xy
coordinates the bridge works in. Reading it back gives a full-brightness approximation of what
the bridge reports, so it can differ slightly from what you set. `color_x` / `color_y` are
those coordinates themselves (each 0–1); SET them for an exact colour with no hex round trip:

```sql
UPDATE hue.main.lights SET color_x = 0.17, color_y = 0.7 WHERE name = 'Sofa lamp';   -- green
UPDATE hue.main.lights SET color_y = 0.3 WHERE name = 'Sofa lamp';   -- color_x keeps its value
```

- Setting only one coordinate keeps the light's current value for the other.
- Setting a colour (either way) switches `color_mode` to `'xy'`.
- `RETURNING` shows the xy you asked for. The bridge may clamp it to what the lamp can show (its
  gamut), so a later read can show slightly different coordinates.
- `color_hex` and `color_x`/`color_y` in one statement are refused (`set either color_hex or
  color_x/color_y, not both`), as are coordinates outside 0–1 and xy on a light without colour
  (`light 'Kitchen pendant' does not support color`).

### Gradients

Gradient lights (Hue gradient lightstrips, Play gradient, Festavia, ...) show several colours at
once. For them the table fills `gradient_points_capable` (how many points the light takes),
`gradient_pixel_count` (how many segments it lights individually), the points themselves as
`gradient_hex` (`VARCHAR[]` of `'#rrggbb'`) and `gradient_xy` (`STRUCT(x DOUBLE, y DOUBLE)[]`),
and `gradient_mode`: how the points are spread (`interpolated_palette`,
`interpolated_palette_mirrored`, `random_pixelated`, `segmented_palette`, whichever the light
lists). Other lights have NULL in all of them.

```sql
SELECT name, gradient_hex, gradient_mode FROM hue.main.lights WHERE gradient_points_capable IS NOT NULL;

UPDATE hue.main.lights SET gradient_hex = ['#ff0000', '#ff8000', '#0000ff'] WHERE name = 'Hallway strip';
UPDATE hue.main.lights SET gradient_xy = [{'x': 0.2, 'y': 0.3}, {'x': 0.6, 'y': 0.35}] WHERE name = 'Hallway strip';
UPDATE hue.main.lights SET gradient_mode = 'segmented_palette' WHERE name = 'Hallway strip';   -- keeps the points

SELECT * FROM hue.main.set_gradient('Hallway strip', ['#00ff00', '#0000ff'], mode := 'random_pixelated');
```

- A gradient needs 2 to `gradient_points_capable` points (the bridge refuses fewer); NULL points, coordinates outside 0–1 and
  modes the light doesn't list are refused before anything is sent.
- `gradient_hex` and `gradient_xy` can't both be set in one statement, and a gradient can't be
  set together with a single colour (`color_hex`, `color_x`/`color_y`,
  `color_temperature_kelvin`): they'd fight over the same light.
- `gradient_mode` alone re-sends the light's current points with the new mode (the bridge wants
  the points with every gradient change). On a light with no gradient left (after a single
  colour) it is refused before anything is sent: "light '<name>' has no gradient to change the
  mode of; set gradient_hex or gradient_xy too".
- Setting a single colour or white temperature on a gradient light replaces the gradient: the
  bridge then lists no points, and `gradient_hex` reads `[]`.
- `set_gradient(light, colors, mode := 'interpolated_palette')` does the same as a function:
  `light` is an id or name (as for `set_light`), `colors` a list of `'#rrggbb'` colours.

### Effects

Lights with built-in effects show the running one in `effect` (`'no_effect'` when none; NULL for
lights without effects). SET it to one of the light's effects (on a colour bulb typically
`candle`, `fire`, `prism`, `sparkle`, `opal`, `glisten`) and back to `'no_effect'` to stop it.
An effect the light doesn't list is refused with the list it does.

```sql
UPDATE hue.main.lights SET effect = 'candle' WHERE room = 'Living room' AND effect IS NOT NULL;
UPDATE hue.main.lights SET effect = 'no_effect' WHERE effect <> 'no_effect';
```

All of these stage in a transactional attach and go out at `COMMIT` like any other light change.

**Pacing.** Hue asks for at most about 10 light commands and 1 room or scene command per
second. The worker starts light commands 100 ms apart (room and scene commands 1 s apart) and
doesn't wait for each answer before starting the next: up to 4 requests are in flight at once,
so 12 lights take about 1.2 s plus one round trip instead of 12 round trips. Requests for the
same light still go one after another, in order, and a room or scene command waits for the
commands before it and runs alone. If the bridge refuses one, no further request starts, the
ones already in flight finish, and the statement fails with the first refusal; lights already
changed stay changed (in a transactional commit they are put back, see below). `COMMIT` sends
its staged requests the same way.

## Transactions

Attach with `transactional true` and light changes wait for `COMMIT`:

```sql
ATTACH 'hue' (TYPE vgi, LOCATION '...', app_key getenv('HUE_APP_KEY'), transactional true);

BEGIN;
UPDATE hue.main.lights SET is_on = true, brightness = 40 WHERE room = 'Kitchen';
SELECT * FROM hue.main.recall_scene('Relax', room := 'Living room');
SELECT name, brightness FROM hue.main.lights WHERE room = 'Kitchen';  -- shows 40: your pending change
COMMIT;      -- everything is sent now, paced and pipelined (see Pacing)
-- or ROLLBACK: nothing was sent, no light changed
```

- `UPDATE` and the control functions stage their requests instead of sending them. `COMMIT`
  sends them in order, merging consecutive changes to the same light. `ROLLBACK` discards them.
- Reads inside the transaction show its pending light changes. Staged room commands and scenes
  aren't reflected in the lights table until they're sent.
- The bridge has no transactions of its own. If it refuses a request part-way through a commit,
  the lights already changed are put back to their state from before the commit, and `COMMIT`
  fails with what happened. That's all-or-nothing in practice, not ACID: another app or a wall
  switch can still change a light mid-transaction.
- DuckDB runs every statement in a transaction. Outside `BEGIN`, a statement applies as it
  commits, right after it runs, and a bridge refusal fails that statement. In a transactional
  attach, `set_room`'s `wait_ms` has nothing to wait for (`settled` is NULL), and `set_lights`
  reports bridge refusals at commit, not per row.
- Works on every transport. Over HTTP, staged changes live in a file on the worker's host, so
  run the HTTP workers for one bridge on a single host.

Without `transactional`, every change is sent as its statement runs, which is the default.

## Controlling with functions

| Function | Changes |
|---|---|
| `set_light(light, ...)` | one light, by id or (case-insensitive) name |
| `set_gradient(light, colors, mode := 'interpolated_palette')` | the points of a gradient light (see [Gradients](#gradients)) |
| `set_room(room, ..., wait_ms := NULL)` | every light in a room or zone at once (its grouped light); `wait_ms` waits until the bulbs report the change |
| `recall_scene(scene, room := NULL)` | activates a scene, by id or name (+ room when the name repeats) |
| `set_lights((query), ...)` | every light a query returns; the query needs a `light_id` column |

State arguments are named and optional; give at least one:

| Argument | Values |
|---|---|
| `power` | `true` / `false` (`on` is a SQL keyword) |
| `brightness` | 0–100; above 0 implies on, 0 turns off |
| `kelvin` | 2000–6500 white temperature (not with `color`) |
| `color` | `'#rrggbb'`, `'#rgb'`, or red / orange / yellow / green / cyan / blue / purple / magenta / pink / white |
| `transition_ms` | fade time in milliseconds |

Each returns one row per change: `target_type`, `target_id`, `name`, `ok`, `error`, the
JSON `request` sent, and `settled`. The bridge relays a room command to each bulb over Zigbee,
so `hue.main.lights` can show the old state for a second or two afterwards. Pass
`wait_ms := 3000` to `set_room` to wait for the bulbs; `settled` says whether every reachable one
reported the change in time (it is NULL when you don't wait). Bad arguments fail at bind, before anything is sent. `set_lights` reports a
failure on one light in that light's row and carries on with the others. It also paces
commands at about 10 per second, as Hue requires.

```sql
SELECT * FROM hue.main.set_light('Desk lamp', brightness := 40, kelvin := 2700);
SELECT * FROM hue.main.set_room('Living room', color := 'orange', brightness := 30, transition_ms := 2000);
SELECT * FROM hue.main.recall_scene('Relax', room := 'Living room');

-- Everything off except the bedroom
SELECT name, ok FROM hue.main.set_lights(
  (SELECT light_id, name FROM hue.main.lights WHERE is_on AND room IS DISTINCT FROM 'Bedroom'),
  power := false);
```

## Project layout

```
src/
  worker.ts      # entry point: stdio / --unix / --http
  cli.ts         # flag parsing; uses HueCatalogInterface
  attach.ts      # bridge / app_key ATTACH options, read via the SDK's attachOptions()
  discovery.ts   # find the bridge: cache, mDNS, discovery.meethue.com
  hue.ts         # CLIP v2 client (retries, pacing), colour math, request bodies
  inventory.ts   # lights / rooms / scenes / sensors tables
  control.ts     # set_light / set_room / recall_scene / set_lights
  lights_write.ts # UPDATE hue.main.lights (rowid -> light, SET -> one PUT per light)
  dispatch.ts    # send a change now, or stage it in the current transaction
  transactions.ts # staging, COMMIT (with restore on refusal), ROLLBACK
  catalog.ts     # assembles the catalog
  meta.ts        # catalog/schema metadata and helpers
test/mock_bridge/server.py   # stateful offline mock of a Hue bridge
test/sql/hue.test            # SQL tests against the mock
tests/functions.test.ts      # unit tests
ci/run-integration.sh        # runs test/sql over stdio / launch / http
ci/lint.sh                   # vgi-lint against the mock bridge
```

### How the ATTACH options reach the functions

`HueCatalogInterface` (in `attach.ts`) declares `bridge` and `app_key` as attach options
(`app_key` secret). Functions and the transaction hooks read them with the SDK's
`attachOptions()`: the SDK carries the options inside `attach_opaque_data`, which DuckDB sends
back on every call, and encrypts the secret `app_key` with a worker-held key, so the app key is
never in plaintext in any opaque value on any transport (over HTTP the whole value is sealed
too). The worker never packs options into its own attach bytes. Binding never contacts the
bridge, so `DESCRIBE` and planning work offline.

## Testing

```bash
make test-unit                 # bun unit tests (include a mock-bridge subprocess)
make test-sql                  # test/sql through DuckDB (stdio); TRANSPORT=launch|http
make lint-explain              # vgi-lint metadata check against the mock bridge
make check                     # everything CI runs
```

All tests run against `test/mock_bridge/server.py`, so they need no bridge and change no
real lights. The mock answers each GET with a 429 the first time, so the retry path is
always exercised. `ci/run-integration.sh` clears `HUE_BRIDGE` / `HUE_APP_KEY`, so your real
bridge never leaks into a test run.

To try it against your real bridge: `HUE_APP_KEY=... make debug` (add `HUE_BRIDGE=...` to skip discovery).

## Deploying over HTTP

```bash
bin/vgi-hue-worker --http --port 8000          # health: GET /health
```

```sql
ATTACH 'hue' (TYPE vgi, LOCATION 'http://localhost:8000', app_key getenv('HUE_APP_KEY'));
```

The worker must be able to reach the bridge on your LAN. Put any hosted worker behind TLS
and [authentication](https://query.farm/vgi/authentication).

## Built from

The [Query.Farm VGI TypeScript starter](https://github.com/Query-farm/vgi-starter-typescript)
(see `.vgi-starter.json`). `make template-diff` shows upstream changes. [AGENTS.md](AGENTS.md)
has the conventions for coding agents.

## License

[BSD Zero Clause License](LICENSE) (0BSD).

## Notebooks

[Executed inventory and battery policy walkthrough](notebooks/README.md).
