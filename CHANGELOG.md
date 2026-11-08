# Changelog

## 0.1.0 (unreleased)

Initial worker generated from the VGI starter template.

- `app_key` (and `bridge`, `transactional`) reach functions and transaction hooks only
  through `@query-farm/vgi` 0.48.5's `attachOptions()`; the SDK encrypts the secret app key
  inside `attach_opaque_data`, so it is never in plaintext in the attach bytes.
- `ci/run-integration.sh` gives every SQL test file a fresh mock bridge (and a fresh HTTP
  worker / launcher pool), so files cannot leak bridge state into each other.

Targets: @query-farm/vgi 0.48 · VGI protocol 3.1 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
