# Search worker

`src/workers/search.mjs` exports `SearchWorker`. It has no dependencies and uses only the entries supplied to `retrieve`. The orchestrator must select the current user's entries first. No global corpus or external content lookup is performed.

## Lexical retrieval

The default is real BM25 (`k1 = 1.2`, `b = 0.75`), using document frequencies from the supplied corpus. Index text is the entry title followed by its text, capped at 24,000 characters. Query text is capped at 4,000 characters. Unicode NFKD normalization removes combining accents; Turkish dotless `ı` is normalized to `i`. Tokens preserve package punctuation (`react-pdf`, `scope/pkg`, `pdf.js`) and additionally index their components. A small English/Turkish stopword list reduces matches caused only by common sentence words.

There is no stemming, translation or heuristic semantic similarity in lexical mode. A Turkish description of an English document may fail to match without configured embeddings. Entries with zero BM25 matches are omitted. Scores are raw BM25 values, not probabilities. Equal scores preserve input order. `limit` is capped at 200.

## Optional semantic retrieval

Construct with:

```js
const search = new SearchWorker({
  embeddingConfig: {
    baseUrl: 'https://provider.example/v1',
    apiKey: process.env.EMBEDDING_API_KEY,
    model: process.env.EMBEDDING_MODEL,
  },
});
const indexed = await search.indexEntries(entries);
// Persist indexed.entries in the user store, including the embedding fields.
const found = await search.retrieve({ query: 'PDF table extraction', entries: indexed.entries });
```

The endpoint is `${baseUrl}/embeddings`. It receives POST JSON `{ model, input: string[], encoding_format: 'float' }` and must return `{ data: [{ index, embedding: number[] }] }`. Indexing batches up to 32 texts per request; searches embed one query. Each request has a 15-second timeout, does not follow redirects, and accepts HTTPS URLs or HTTP loopback URLs for local providers. API keys are request headers only. Configure the endpoint through trusted server configuration, never a user-supplied HTTP body.

The chosen provider receives the bounded entry title/text and query. With no configuration, there are no network requests. Credentials and raw provider errors are excluded from warnings.

Each indexed entry contains `{ embedding: { model, vector, hash } }`. SHA-256 hashes cover exactly the bounded text sent to the provider. A valid unchanged hash/model/vector skips indexing. Changed text or model triggers indexing. Successful vectors are returned for persistence; the worker itself owns no store. Inputs are cloned when indexing and are never mutated during retrieval.

Current, valid embeddings are compared by cosine similarity. Only positive cosine scores enter semantic candidates. Separate BM25 and cosine lists are fused with reciprocal rank fusion: `sum(1 / (60 + rank))`, with one-based ranks. Each list contributes up to `max(80, 2 * limit)` candidates. `retrievalScore` is the RRF score in hybrid mode; `lexicalScore` remains raw BM25; `semanticScore` is cosine or `null` when absent. None of these is a calibrated relevance probability. Positive cosine alone does not prove relevance; downstream Jev ranking evaluates candidate usefulness.

## Degradation and validation

Unconfigured embeddings return lexical mode with a warning. Missing or stale vectors also produce explicit warnings. Partial indexing can use hybrid search over the available current vectors, while other entries participate through lexical matches. Provider failures, invalid response indices, non-finite or zero vectors, and incompatible dimensions fall back to lexical search with sanitized warnings. Invalid batches are discarded and indexing stops on a failed batch to avoid repeated outage calls; earlier successful batches remain available. No vectors or semantic scores are invented.

Embedding responses must include a unique integer `index` for each input; arbitrary response order is supported. Vectors must have 1–32,768 finite dimensions and nonzero finite norm. Dimension mismatch during query retrieval causes full lexical fallback so incompatible spaces are never compared. The model name is a cache namespace: if a provider changes a model's behavior without changing its name, administrators should change the configured model identifier or clear stored embeddings before reindexing.

## Verification

Run `node --test test/search.test.mjs` from the Recall directory. Tests inject fetch functions, perform no network calls, and cover BM25 ordering and no-match behavior, Unicode normalization, stable ties, persistent cache reuse and reindexing, batching, RRF, cosine values, malformed responses, mismatched dimensions, outages, disabled networking, stale embeddings, scope isolation and input immutability.
