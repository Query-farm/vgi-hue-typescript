# Common tasks. `make help` lists them. Requires Bun (https://bun.sh) and uv (https://docs.astral.sh/uv/).
# managed-by: vgi-starters (language section below is typescript-specific)

HAYBARN_VERSION ?= 2.0.0rc11
# vgi-lint is deliberately not pinned: the gate tracks the current quality bar.
VGI_LINT        := uvx --prerelease=allow --from 'vgi-lint-check>=2,<3' vgi-lint lint
LINT_ARGS       ?=
WORKER          := $(CURDIR)/bin/vgi-hue-worker
TOOLS           := $(CURDIR)/.tools
HAYBARN_UNITTEST := $(TOOLS)/bin/haybarn-unittest
TRANSPORT       ?= stdio

.DEFAULT_GOAL := help
.PHONY: pair help build test test-unit test-sql test-sql-all lint lint-explain lint-ai fmt check run run-http debug tools template-diff clean

help: ## List the targets
	@awk 'BEGIN{FS=":.*## "} /^[a-zA-Z_-]+:.*## /{printf "  %-14s %s\n",$$1,$$2}' $(MAKEFILE_LIST)


build: ## Install the worker's dependencies into node_modules
	bun install --frozen-lockfile

tools: ## Install the pinned SQL test runner into .tools
	@test -x $(HAYBARN_UNITTEST) || { uv venv -q $(TOOLS) && uv pip install -q -p $(TOOLS) haybarn-unittest==$(HAYBARN_VERSION); }

fmt: ## Format the code
	bun x biome check --write .

lint: build ## Static checks: biome (format + lint), tsc --noEmit
	bun x biome ci .
	bun x tsc --noEmit

test-unit: build ## Unit tests (bun test)
	bun test

test-sql: build tools ## SQL tests through DuckDB: make test-sql TRANSPORT=stdio|launch|http
	WORKER=$(WORKER) RECIPES_WORKER="$(CURDIR)/bin/run-recipe" HAYBARN_UNITTEST=$(HAYBARN_UNITTEST) TRANSPORT=$(TRANSPORT) PYTHON="uv run --no-project python" ci/run-integration.sh

test-sql-all: ## SQL tests over every transport
	$(MAKE) test-sql TRANSPORT=stdio
	$(MAKE) test-sql TRANSPORT=launch
	$(MAKE) test-sql TRANSPORT=http

test: test-unit test-sql ## Unit + SQL tests

lint-explain: build ## Metadata quality report against the mock bridge (vgi-lint, settings in vgi-lint.toml). LINT_ARGS="--format agent" for agents
	PYTHON="uv run --no-project python" ci/lint.sh $(VGI_LINT) "$(WORKER)" $(LINT_ARGS)

lint-ai: ## Opt-in L3 check: an agent runs vgi-agent-tests.yaml and docs are reviewed (needs the claude CLI)
	@$(MAKE) --no-print-directory lint-explain LINT_ARGS="--ai $(LINT_ARGS)"

check: lint test-unit test-sql-all lint-explain ## Everything CI runs. Done = this passes.

run: build ## Serve over stdio (what DuckDB launches)
	$(WORKER)

run-http: build ## Serve over HTTP on port 8000
	$(WORKER) --http --host 127.0.0.1 --port 8000

pair: build ## Create a Hue app key: press the bridge's link button when asked (saved to ~/.config/vgi-hue/app_key)
	bun run src/pair.ts $(PAIR_ARGS)

debug: build tools ## Run one query against the worker with debug logging on stderr
	@printf "LOAD vgi;\nATTACH 'hue' (TYPE vgi, LOCATION '$(WORKER) --debug', app_key getenv('HUE_APP_KEY'));\nSELECT name, is_on, brightness FROM hue.main.lights;\n" \
	  | uvx --from haybarn-cli==$(HAYBARN_VERSION) haybarn -no-agent

template-diff: ## Show upstream template changes since this project was created
	uv run --no-project python scripts/vgi_template.py template-diff --stat

clean: ## Remove build outputs and tool caches
	rm -rf node_modules .tools dist
