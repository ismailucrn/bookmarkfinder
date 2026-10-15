# Bookmark Finder development agents

The user explicitly requested an orchestrator and worker agents for both development and the product runtime. Read STATUS.md first for the current stage, pending work and verification limits. Use this directory as the local Codex project root; keep the deliverable in one main folder with separate source files.

## User development-model policy

Every NEW development subagent must be spawned explicitly with model `gpt-6.1-sol` and reasoning effort `high`. With the collaboration API, provide `model: "gpt-6.1-sol"`, `reasoning_effort: "high"` and `fork_turns: "none"`; include the relevant task context in the prompt. Do not silently inherit another model or effort. This policy applies to new development work; do not claim that previously completed agents were retroactively changed.

Development agent selection is separate from the product runtime. The runtime scoring provider remains Jev (`JEV_MODEL`); embeddings use the configured embedding provider/model. Do not replace either with the development model merely because of this policy.

The backend is Node.js. `npm run setup` prepares the local `.env` and `.venv` without overwriting an existing `.env`. The Python `.venv` is only for `scripts/package.py`, invoked by `npm run package`; it is not the backend runtime. Never package local secrets, data or virtual environments.

## Orchestrator (parent agent)

Own integration decisions, task boundaries, store, local API/CLI, public documentation, end-to-end tests and final delivery. Delegate bounded tasks with the contracts in docs/CONTRACTS.md. Review worker results; test the combined system. Do not claim live provider tests without credentials and a successful real request. Do not print or commit secrets.

## Worker responsibilities

| Worker | Owned files | Responsibility |
| --- | --- | --- |
| ingestion_worker | src/workers/connectors.mjs; test/connectors.test.mjs; docs/connectors.md | Read-only GitHub/X import, safe pagination and incomplete snapshots |
| search_worker | src/workers/search.mjs; test/search.test.mjs; docs/search.md | Indexing/cache, BM25, genuine embeddings/cosine/RRF and explicit fallback |
| jev_worker | src/workers/jev.mjs; test/jev.test.mjs; docs/jev.md | Official TypeSafe Score API, validation, relevance ranking, bounded concurrency/fallback |

No worker edits another worker's files without the orchestrator explicitly reassigning ownership. Cross-review is read-only; send actionable findings to the owner. The parent runs the entire test suite after integration.

## Runtime constraints

Node >=24, ES modules, built-ins only. No credentials in sources, fixtures, traces, test reports or browser requests. HTTP stays bound to 127.0.0.1; adding remote hosting requires real authentication and authorization first. Entries/jobs must always be scoped by user. Do not report retrieval scores as probabilities or confidence as relevance. Preserve old data on incomplete/failed sync. Keep demo isolated and explicit.

## Required checks

Run `npm test`, `npm run check`, `npm run demo` from this directory after relevant changes. Tests call third-party services through injected mocks; real HTTP integration binds loopback. Report unavailable verification accurately. Do not deploy or start background recurring work as part of routine development.
