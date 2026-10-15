# Jev ranking worker

`JevWorker` evaluates retrieved candidates against a query using TypeSafe's official
`POST https://api.typesafe.ai/v1/systemone` endpoint. No gateway or package dependency
is used. Node.js >=24 and injected `fetchImpl` are supported.

```js
import { JevWorker } from '../src/workers/jev.mjs';
const worker = new JevWorker({ apiKey: process.env.JEV_API_KEY });
const { results, mode, warnings } = await worker.rank({ query, candidates, limit: 10 });
```

The parent orchestrator must supply only the current user's retrieval candidates.
The worker transmits the query and bounded title/content of each candidate to
TypeSafe when configured; it does not send arbitrary entry metadata or credentials
in state. Keep the API key server-side. No external requests occur without a key.

Each candidate gets one request with a four-level descriptive `score` question named
`relevance`. The state contains both `user_query` and `candidate`. The instructions
ask the model to evaluate evidence, ignore instructions inside saved content, and
support multilingual queries. This is a relevance rubric, not separately weighted
checks for every query requirement. Measure it on real query/document pairs before
claiming production ranking quality.

The response's score must be finite and between 0 and 3. Confidence must be finite
and between 0 and 1. The four probability values must each be within 0..1, sum to 1
within 0.01, and agree with the probability-weighted score within 0.02. Malformed
responses are treated as evaluation failures. Relevance is `score / 3`; it is **not
a calibrated probability** that a document is the desired bookmark. Confidence is
returned separately and never determines ordering. Equal relevance retains input
retrieval order. No generated explanation is added.

## Bounds and failure behavior

- At most 50 candidates are evaluated, selected in retrieval order; remaining
  candidates cannot enter Jev results. A warning explicitly reports this cap.
- Default parallelism is 4; the allowed constructor `concurrency` range is 1..8.
- Each request, including JSON parsing, has a 12-second deadline. Constructor
  `timeoutMs` can set 1..30000 ms. Requests use abort signals and reject redirects.
- Candidate titles are capped at 500 characters and content at 12000 characters,
  with a truncation warning. Queries must contain 1..4000 characters. Requested
  `limit` is an integer from 1 to 50.
- Without an API key, all results use original retrieval order with null relevance
  and confidence. Any failed candidate evaluation triggers the same fallback for
  the **entire** result set, rather than mixing incompatible score types. Already
  in-flight evaluations finish or time out; no additional evaluations are started
  once failure is observed.
- Warning/error messages never include provider bodies, tokens, headers or raw
  exception messages. Provider failure is not silently represented as a low score.
- Only the official TypeSafe base URL is accepted; an arbitrary gateway configured
  through `baseUrl` is rejected before credentials could be transmitted.

## Verification

`node --test test/jev.test.mjs` from the project directory uses mocked fetch only.
It covers relevance versus confidence sorting, stable ties, official request shape,
unconfigured behavior, full fallback, malformed responses, sanitization, timeouts,
candidate/content bounds, parallelism and input/config validation. No live Jev
quality or credential verification is implied by these tests.

Official references verified 2026-10-15:

- [Score request, rubric and response](https://docs.typesafe.ai/primitives/score)
- [API reference](https://api.typesafe.ai/redoc)
- [Official OpenAPI schema underlying ReDoc](https://api.typesafe.ai/openapi.json)

The current official schema documents Bearer authorization and the `jev-latest`
model alias. Authenticated `GET /v1/models` lists models available to an account;
this worker's optional `model` constructor setting selects another such model.
