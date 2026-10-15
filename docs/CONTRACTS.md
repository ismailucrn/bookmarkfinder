# Recall worker contracts

Runtime: Node.js >=24 ES modules, built-in APIs only. No package dependencies.

## Entry

```js
{
 id: 'github:123', // globally stable source:externalId
 source: 'github' | 'x' | 'manual',
 externalId: '123',
 url: 'https://github.com/owner/repo',
 title: 'owner/repo',
 text: 'description and README or post text',
 metadata: {}, // JSON, never credentials
 savedAt: null, // ISO timestamp when genuinely available
 updatedAt: 'ISO timestamp',
 embedding: { model: 'provider-model', vector: [0.1], hash: 'content hash' } // optional
}
```

Each module owns only its files and tests. Do not modify other modules. Credentials are constructor/call arguments, never part of entries, traces or error text. No dependencies. Inject `fetchImpl = globalThis.fetch` for tests. Errors must not expose upstream bodies, tokens, raw exception messages, or request headers. Explicit warnings explain degraded operation.

## Ingestion worker — src/workers/connectors.mjs

Exports:
- `fetchGithubStars({ token, fetchImpl = globalThis.fetch, signal })`
- `fetchXBookmarks({ token, userId, fetchImpl = globalThis.fetch, signal })`

Both return `{ entries, complete: boolean, warnings: string[] }`. Network/API failures throw sanitized Error; incomplete pagination/limits return complete:false and warning. The caller only replaces an existing source snapshot when complete:true. Limit requests and README text; fetch README for each GitHub repo without following arbitrary links. Use approved fixed API domains. GitHub token authenticates the current account, X userId is the provider account ID. No OAuth UI in this first backend. Do not fetch post-linked websites. Get only read scopes. Test pagination, bounds, failures, sanitization with mocked fetch. Entries must contain no tokens. API base URLs fixed internally.

## Search worker — src/workers/search.mjs

Exports class `SearchWorker`.
Constructor `{ embeddingConfig = null, fetchImpl = globalThis.fetch }`; embeddingConfig `{ baseUrl, apiKey, model }` for an embeddings-compatible endpoint (`baseUrl` includes /v1, POST /embeddings). No external request if unconfigured.
- `indexEntries(entries)` -> `{ entries, warnings: string[] }`. Produce/preserve per-entry `embedding` (model/vector/hash), skip unchanged content, batch HTTP requests where possible. Return explicit warnings on disabled/failed embeddings, do not invent semantic scores.
- `retrieve({ query, entries, limit = 40 })` -> `{ candidates, mode, warnings }`. Each candidate `{ entry, retrievalScore, lexicalScore, semanticScore }`. Use lexical ranking (BM25 or documented equivalent) plus cosine semantic ranking fused by RRF when configured and indexed. Respect stable ties. Exclude completely unrelated lexical matches in lexical-only mode. `mode` = `hybrid` or `lexical`. Do not mutate inputs. Validate vectors; failure explicitly falls back. Only use entries supplied by caller (already user-filtered).

## Jev worker — src/workers/jev.mjs

Exports class `JevWorker`.
Constructor `{ apiKey = '', baseUrl = 'https://api.typesafe.ai/v1', model = 'jev-latest', fetchImpl = globalThis.fetch, concurrency = 4 }`.
- `rank({ query, candidates, limit = 10 })` -> `{ results, mode, warnings }`.
Results extend candidate with `{ relevanceScore, confidence, rankingMethod }`. Score rubric four descriptive levels 0..3; relevanceScore = score/3, confidence is separate. Sort by relevanceScore, NOT confidence. `mode`='jev' or 'retrieval'. Disabled/failed Jev uses retrieval order, relevanceScore:null/confidence:null/rankingMethod:'retrieval'; full fallback if partial failure so scores are comparable. Reject malformed upstream responses. Bounded concurrency, timeouts, caps. Official endpoint POST /systemone with {state, model, questions:{relevance:{type:'score',instructions,criteria:[...]}}}; response answers.relevance.{score,confidence,probabilities}. No fabricated explanations. Tests no real API calls.

## Integration conventions

Root owns store.mjs, orchestrator.mjs, server.mjs, cli.mjs, package.json, README, fixtures and integration tests. Root supplies only relevant user entries to search. Secrets read from environment in config, never accepted in HTTP bodies or returned. Local HTTP binds 127.0.0.1 with single local principal; remote/multiuser deployment requires real auth. Traces are stage metadata, no content or secrets.
