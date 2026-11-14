# Hue notebooks

[01 · Inventory is not confirmation of device state](01_inventory_is_not_device_confirmation.ipynb) distinguishes stored brightness, reported power, reachability and unavailable readings before applying a transparent battery review threshold.

## Run

Install [Bun](https://bun.sh/), [uv](https://docs.astral.sh/uv/) and Git. The notebook environment uses Python 3.13–3.14; uv can install it. Initial dependency and source downloads need internet. No Hue device, credentials or local worker checkout are required.

```sh
cd notebooks
uv sync --locked
uv run --locked python execute.py --timeout 300
```

Haybarn 2.0.0rc11 connects through the literal visible command `bun run github_worker.ts Query-farm/vgi-hue-typescript 08f4dc8e20cf8f0717093cda99dc1035fa91f397 src/worker.ts`. This repository has no published worker release/package. The companion launcher fetches and verifies that immutable Git commit, installs its frozen Bun lockfile, and caches by repository, revision and Bun version under `${XDG_CACHE_HOME:-~/.cache}/vgi-notebook-workers`. A bounded lock serializes cache construction; the completed cache is published atomically and its marker checked before reuse. All setup output goes to stderr. Upgrade the source pin deliberately, then revalidate both runs.

Optional editor kernel:

```sh
uv run --locked python -m ipykernel install --user --name vgi-hue-notebooks --display-name "Python (vgi-hue notebooks)"
```

Use this directory as the working directory and Restart Kernel → Run All. `execute.py` creates a temporary kernel and replaces saved outputs only after every cell succeeds. Logs, extracted charts, environments and separate experiments are ignored.

## Experiment

```sh
uv run --locked python execute.py --parameters '{"BATTERY_THRESHOLD_PCT":80}' --output-dir artifacts/threshold-80
```

The default is 20 percent, inclusive. Overrides require a separate destination; the runner copies the fixture, launcher, documentation, lock and branding beside that executed notebook. Restore 20 for the default.

## Explicit synthetic fixture

`mock_bridge.py` is an unchanged copy of `test/mock_bridge/server.py` at the pinned source revision (repository license applies). Its five lights and sensor services are synthetic test inputs, including an unreachable desk lamp, off lights with retained brightness, disabled sensor services with stale payload values, and battery levels with no change timestamps. The worker clears disabled readings and timestamps while preserving the rows. Fixed sensor change timestamps are in October/November 2026 UTC; execution time does not refresh them.

`fixture_bridge.py` starts that fixture on an ephemeral loopback port with inherited `MOCK_*` and `HUE_*` settings removed from its process, owns its PID, and restores its notebook endpoint setting during cleanup. Explicit ATTACH options always select the local bridge and its public non-secret `test-key`; real environment credentials and discovery are bypassed. The fixture implements no forwarding. Both source tables are materialized once. Subsequent analysis is local and asserts that the mock recorded no PUT commands.

Reported brightness is a setting, not lumens or electricity use; even reachable/on is a bridge report rather than physical confirmation. Battery percentages do not estimate remaining life. NULL readings remain unavailable rather than zero. The inclusive notebook review threshold is distinct from the bridge's `battery_state` label. The experiment changes the policy, not the device state.

## Real bridge setup is separate

The root README documents pairing and live access. A separate reader-authored live analysis would need an authorized bridge endpoint and an application key supplied as a secret/environment setting, plus a decision about freshness and reachability. This notebook has no live switch and does not pair, discover or control real devices. Do not replace fixture values and then claim its synthetic provenance or checks still apply.

The Haybarn connection uses an empty temporary SQL secret directory with persistent
secrets disabled. The selected worker path receives only explicit fixture dummy
credentials. Assertions confirm no SQL secrets exist before ATTACH or at cleanup.
Existing saved SQL credentials are neither loaded nor modified.
