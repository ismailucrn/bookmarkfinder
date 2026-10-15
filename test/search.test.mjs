import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchWorker } from '../src/workers/search.mjs';

const entry = (id, title, text = '') => ({ id, source: 'manual', externalId: id, title, text, metadata: {}, url: `https://example.com/${id}` });
const config = { baseUrl: 'https://embeddings.example/v1', apiKey: 'SECRET', model: 'test-model' };
function api(vectors, requests = []) {
  return async (url, init) => {
    const request = JSON.parse(init.body);
    requests.push({ url, ...request });
    const values = typeof vectors === 'function' ? vectors(request.input) : vectors;
    return new Response(JSON.stringify({ data: values.map((embedding, index) => ({ index, embedding })) }));
  };
}

test('BM25 ranks exact package names and omits unrelated documents', async () => {
  const entries = [entry('1', 'react pdf', 'Basic React editor'), entry('2', 'react-pdf', 'PDF reader for React'), entry('3', 'sqlite', 'A database')];
  const worker = new SearchWorker({ fetchImpl: () => { throw new Error('Must not fetch'); } });
  const result = await worker.retrieve({ query: 'react-pdf', entries });
  assert.equal(result.mode, 'lexical');
  assert.equal(result.candidates[0].entry.id, '2');
  assert.deepEqual(result.candidates.map(candidate => candidate.entry.id).sort(), ['1', '2']);
  assert.ok(result.candidates.every(candidate => candidate.semanticScore === null));
  assert.ok(result.warnings.length);
  assert.equal((await worker.retrieve({ query: 'a unicorn with sparkles', entries })).candidates.length, 0);
});

test('Unicode normalization supports Turkish casing, package paths, and stable ties', async () => {
  const worker = new SearchWorker();
  const entries = [entry('b', 'IŞIK @scope/pdf.js'), entry('a', 'IŞIK @scope/pdf.js')];
  const result = await worker.retrieve({ query: 'ışık @scope/pdf.js', entries });
  assert.deepEqual(result.candidates.map(candidate => candidate.entry.id), ['b', 'a']);
  assert.equal(result.candidates[0].lexicalScore, result.candidates[1].lexicalScore);
});

test('index batches, persists hashes, skips unchanged content and leaves input untouched', async () => {
  const requests = [];
  const fetchImpl = api(input => input.map(() => [1, 0]), requests);
  const worker = new SearchWorker({ embeddingConfig: config, fetchImpl });
  const entries = Array.from({ length: 35 }, (_, index) => entry(String(index), `PDF ${index}`));
  const indexed = await worker.indexEntries(entries);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].input.length, 32);
  assert.equal(requests[0].url, 'https://embeddings.example/v1/embeddings');
  assert.equal(entries[0].embedding, undefined);
  assert.match(indexed.entries[0].embedding.hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(indexed).includes('SECRET'), false);
  const cached = await worker.indexEntries(indexed.entries);
  assert.equal(requests.length, 2);
  assert.deepEqual(cached, indexed);
  cached.entries[0].text = 'new text';
  await worker.indexEntries(cached.entries);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].input.length, 1);
});

test('RRF fuses genuine semantic ranking and lexical matching', async () => {
  const worker = new SearchWorker({ embeddingConfig: config, fetchImpl: api(input => input.map(text => text.includes('charts') ? [0.8, 0.6] : [1, 0])) });
  const { entries } = await worker.indexEntries([entry('1', 'PDF reader'), entry('2', 'charts')]);
  const result = await worker.retrieve({ query: 'PDF', entries });
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.candidates[0].entry.id, '1');
  assert.equal(result.candidates[0].semanticScore, 1);
  assert.equal(result.candidates[0].retrievalScore, 2 / 61);
  assert.equal(result.candidates[1].lexicalScore, 0);
  assert.equal(result.candidates[1].semanticScore, 0.8);
});

test('dimensions mismatch causes explicit full lexical fallback', async () => {
  const worker = new SearchWorker({ embeddingConfig: config, fetchImpl: api([[1, 0]]) });
  const { entries } = await worker.indexEntries([entry('1', 'PDF reader')]);
  worker.fetchImpl = api([[1, 0, 0]]);
  const result = await worker.retrieve({ query: 'PDF', entries });
  assert.equal(result.mode, 'lexical');
  assert.equal(result.candidates[0].semanticScore, null);
  assert.ok(result.warnings.length);
});

test('embedding outage is sanitized and leaves lexical search working', async () => {
  const worker = new SearchWorker({ embeddingConfig: config, fetchImpl: api([[1, 0]]) });
  const { entries } = await worker.indexEntries([entry('1', 'PDF reader')]);
  worker.fetchImpl = async () => { throw new Error('SECRET PRIVATE upstream body'); };
  const result = await worker.retrieve({ query: 'PDF', entries });
  assert.equal(result.mode, 'lexical');
  assert.equal(result.candidates[0].entry.id, '1');
  assert.ok(result.warnings.length);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('invalid batch fails visibly and does not store bad or partial vectors', async () => {
  const worker = new SearchWorker({ embeddingConfig: config, fetchImpl: api([[1, 0], [1, 0, 0]]) });
  const result = await worker.indexEntries([entry('1', 'PDF'), entry('2', 'reader')]);
  assert.ok(result.warnings.length);
  assert.ok(result.entries.every(item => !item.embedding));
  worker.fetchImpl = api([[0, 0], [1, 0]]);
  assert.ok((await worker.indexEntries(result.entries)).warnings.length);
});

test('duplicate response indices and non-finite vectors are rejected', async () => {
  const worker = new SearchWorker({ embeddingConfig: config, fetchImpl: async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] })) });
  assert.ok((await worker.indexEntries([entry('1', 'a'), entry('2', 'b')])).warnings.length);
  worker.fetchImpl = api([[Number.NaN]]);
  assert.ok((await worker.indexEntries([entry('1', 'PDF')])).warnings.length);
});

test('outage stops remaining batches and disabled indexing never calls endpoint', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return { ok: false }; };
  const entries = Array.from({ length: 65 }, (_, index) => entry(String(index), 'PDF'));
  const result = await new SearchWorker({ embeddingConfig: config, fetchImpl }).indexEntries(entries);
  assert.equal(requests, 1);
  assert.ok(result.warnings.length);
  const disabled = await new SearchWorker({ fetchImpl }).indexEntries(entries);
  assert.equal(requests, 1);
  assert.ok(disabled.warnings.length);
});

test('retrieval stays within caller scope, does not mutate and handles stale embeddings', async () => {
  const worker = new SearchWorker({ embeddingConfig: config, fetchImpl: api(input => input.map(() => [1, 0])) });
  const { entries } = await worker.indexEntries([entry('userA', 'PDF'), entry('userB', 'PDF')]);
  const snapshot = structuredClone(entries);
  const result = await worker.retrieve({ query: 'PDF', entries: [entries[0]] });
  assert.deepEqual(result.candidates.map(candidate => candidate.entry.id), ['userA']);
  assert.deepEqual(entries, snapshot);
  entries[0].text = 'changed';
  assert.equal((await worker.retrieve({ query: 'PDF', entries: [entries[0]] })).mode, 'lexical');
  assert.deepEqual((await worker.retrieve({ query: '', entries })).candidates, []);
  assert.deepEqual((await worker.retrieve({ query: 'PDF', entries, limit: 0 })).candidates, []);
});

test('unsafe base URLs reject without leaking URL credentials', () => {
  for (const baseUrl of ['http://external.example/v1', 'https://user:SECRET@example.com/v1', 'not-a-url']) {
    assert.throws(() => new SearchWorker({ embeddingConfig: { ...config, baseUrl } }), error => !error.message.includes('SECRET'));
  }
  assert.doesNotThrow(() => new SearchWorker({ embeddingConfig: { ...config, baseUrl: 'http://127.0.0.1:8080/v1' } }));
});

test('embedding response ordering is restored by input index', async () => {
  const worker = new SearchWorker({ embeddingConfig: config, fetchImpl: async () => new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] })) });
  const result = await worker.indexEntries([entry('1', 'PDF'), entry('2', 'charts')]);
  assert.deepEqual(result.entries.map(item => item.embedding.vector), [[1, 0], [0, 1]]);
});

test('corrupted cached vectors trigger visible lexical fallback without network', async () => {
  let calls = 0;
  const worker = new SearchWorker({ embeddingConfig: config, fetchImpl: async (...args) => { calls++; return api([[1, 0]])(...args); } });
  const { entries } = await worker.indexEntries([entry('1', 'PDF')]);
  entries[0].embedding.vector = [0, 0];
  const result = await worker.retrieve({ query: 'PDF', entries });
  assert.equal(calls, 1);
  assert.equal(result.mode, 'lexical');
  assert.equal(result.candidates[0].semanticScore, null);
  assert.ok(result.warnings.length);
});

test('C++, C#, and C are distinct technical terms rather than equal lexical matches', async () => {
  const worker = new SearchWorker();
  const entries = [entry('sharp', 'C# tools'), entry('plain', 'C tools'), entry('plus', 'C++ tools')];
  for (const [query, expected] of [['C++', 'plus'], ['C#', 'sharp'], ['C', 'plain']]) {
    const result = await worker.retrieve({ query, entries });
    assert.deepEqual(result.candidates.map(candidate => candidate.entry.id), [expected]);
  }
});

test('language markers remain distinct inside package paths', async () => {
  const worker = new SearchWorker();
  const entries = [entry('sharp', 'samples/C#/parser'), entry('plus', 'samples/C++/parser')];
  assert.deepEqual((await worker.retrieve({ query: 'C++', entries })).candidates.map(candidate => candidate.entry.id), ['plus']);
  assert.deepEqual((await worker.retrieve({ query: 'C#', entries })).candidates.map(candidate => candidate.entry.id), ['sharp']);
});

test('oversized streamed embedding bodies are cancelled before parsing or fully consuming', async () => {
  let cancelled = false;
  let produced = 0;
  const chunk = new Uint8Array(1024 * 1024).fill(32);
  const stream = new ReadableStream({
    pull(controller) { produced++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const worker = new SearchWorker({ embeddingConfig: config, fetchImpl: async () => new Response(stream) });
  const indexed = await worker.indexEntries([entry('pdf', 'PDF')]);
  assert.ok(indexed.warnings.length);
  assert.equal(indexed.entries[0].embedding, undefined);
  assert.equal(cancelled, true);
  assert.equal(produced, 9);
});

test('declared oversized embedding responses are rejected without reading body', async () => {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array([32])); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const worker = new SearchWorker({ embeddingConfig: config, fetchImpl: async () => new Response(body, { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }) });
  assert.ok((await worker.indexEntries([entry('pdf', 'PDF')])).warnings.length);
  assert.equal(reads, 0);
  assert.equal(cancelled, true);
});

test('oversized embedding query response visibly falls back to lexical retrieval', async () => {
  const worker = new SearchWorker({ embeddingConfig: config, fetchImpl: api([[1, 0]]) });
  const { entries } = await worker.indexEntries([entry('pdf', 'PDF')]);
  worker.fetchImpl = async () => new Response(' '.repeat(8 * 1024 * 1024 + 1));
  const result = await worker.retrieve({ query: 'PDF', entries });
  assert.equal(result.mode, 'lexical');
  assert.equal(result.candidates[0].semanticScore, null);
  assert.ok(result.warnings.length);
});

test('JSON-only fake responses cannot bypass bounded streaming validation', async () => {
  let parsed = false;
  const worker = new SearchWorker({ embeddingConfig: config, fetchImpl: async () => ({ ok: true, json: async () => { parsed = true; return { data: [{ index: 0, embedding: [1, 0] }] }; } }) });
  assert.ok((await worker.indexEntries([entry('pdf', 'PDF')])).warnings.length);
  assert.equal(parsed, false);
});
