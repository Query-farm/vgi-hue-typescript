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
| `hue.main.lights` | light: `light_id`, `name`, `room`, `is_on`, `brightness` (0–100), `color_mode`, `color_temperature_kelvin`, `color_x`/`color_y`, `color_hex`, `reachable`, `product_name`, `model_id`, `device_id` |
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

## Controlling

| Function | Changes |
|---|---|
| `set_light(light, ...)` | one light, by id or (case-insensitive) name |
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
  attach.ts      # bridge / app_key ATTACH options -> attach_opaque_data
  discovery.ts   # find the bridge: cache, mDNS, discovery.meethue.com
  hue.ts         # CLIP v2 client (retries, pacing), colour math, request bodies
  inventory.ts   # lights / rooms / scenes / sensors tables
  control.ts     # set_light / set_room / recall_scene / set_lights
  catalog.ts     # assembles the catalog
  meta.ts        # catalog/schema metadata and helpers
test/mock_bridge/server.py   # stateful offline mock of a Hue bridge
test/sql/hue.test            # SQL tests against the mock
tests/functions.test.ts      # unit tests
ci/run-integration.sh        # runs test/sql over stdio / launch / http
ci/lint.sh                   # vgi-lint against the mock bridge
```

### How the ATTACH options reach the functions

`HueCatalogInterface` (in `attach.ts`) declares `bridge` and `app_key` as attach options.
When you attach, it packs them into the catalog's `attach_opaque_data`, which DuckDB sends
back on every call. Over HTTP the SDK seals those bytes in an encrypted envelope bound to the
caller. Binding never contacts the bridge, so `DESCRIBE` and planning work offline.

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
