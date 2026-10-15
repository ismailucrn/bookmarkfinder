import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { SearchWorker } from '../src/workers/search.mjs';
import { JevWorker } from '../src/workers/jev.mjs';
import { Store } from '../src/store.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { makeServer } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';

const config = () => ({ demo: false, githubToken: '', xToken: '', xUserId: '', jevConfig: {}, embeddingConfig: null });
const entry = (id = '1', title = 'Python PDF tables') => ({ id: `github:${id}`, source: 'github', externalId: id,
  title, text: 'Extract PDF tables with Python', url: `https://github.com/demo/repo${id}`, metadata: {}, savedAt: null, updatedAt: '2026-10-08T00:00:00Z' });
function setup(options = {}) {
  const store = new Store();
  const orchestrator = new Orchestrator({ store, config: config(), ...options });
  return { store, orchestrator };
}

test('real pipeline returns ranked source links without fabricated Jev or semantic scores', async t => {
  const { store, orchestrator } = setup(); t.after(() => store.close());
  await orchestrator.importEntries('alice', [entry()]);
  const result = await orchestrator.search('alice', { query: 'PDF Python' });
  assert.equal(result.results[0].id, 'github:1');
  assert.equal(result.mode.retrieval, 'lexical'); assert.equal(result.mode.ranking, 'retrieval');
  assert.equal(result.results[0].semanticScore, null); assert.equal(result.results[0].relevanceScore, null);
  assert.equal(result.results[0].confidence, null); assert.ok(result.warnings.length >= 2);
  assert.deepEqual(result.trace.map(x => x.worker), ['search', 'jev']);
  assert.ok(result.trace.every(x => x.state === 'succeeded'));
});

test('user isolation applies before retrieval and job lookups', async t => {
  const { store, orchestrator } = setup(); t.after(() => store.close());
  await orchestrator.importEntries('alice', [entry('1')]);
  await orchestrator.importEntries('bob', [entry('2', 'Private Bob Python PDF')]);
  const result = await orchestrator.search('alice', { query: 'PDF' });
  assert.equal(result.corpusSize, 1); assert.deepEqual(result.results.map(x => x.id), ['github:1']);
  const job = orchestrator.enqueueIndex('alice'); await orchestrator.drain();
  assert.throws(() => orchestrator.getJob('bob', job.id), /bulunamadı/);
  await orchestrator.clear('alice'); assert.equal(store.counts('bob').total, 1);
});

test('incomplete source snapshots never delete previously saved records; complete snapshots replace', async t => {
  let complete = false;
  const { store, orchestrator } = setup({ config: { ...config(), githubToken: 'secret' }, connectors: {
    github: async () => ({ entries: [entry('2')], complete, warnings: [] }),
  } }); t.after(() => store.close());
  await orchestrator.importEntries('alice', [entry('1')]);
  const job = orchestrator.enqueueSync('alice', 'github'); await orchestrator.drain();
  assert.equal(orchestrator.getJob('alice', job.id).state, 'succeeded');
  assert.equal(store.counts('alice').total, 2);
  complete = true;
  const job2 = orchestrator.enqueueSync('alice', 'github'); await orchestrator.drain();
  assert.equal(orchestrator.getJob('alice', job2.id).result.complete, true);
  assert.deepEqual(store.list('alice').map(x => x.id), ['github:2']);
});

test('provider failures preserve snapshots, sanitize persisted errors, and allow retry', async t => {
  let failure = true;
  const { store, orchestrator } = setup({ config: { ...config(), githubToken: 'secret-value' }, connectors: {
    github: async () => { if (failure) throw new Error('secret-value https://upstream/private'); return { entries: [], complete: true, warnings: [] }; },
  } }); t.after(() => store.close());
  await orchestrator.importEntries('alice', [entry()]);
  const job = orchestrator.enqueueSync('alice', 'github'); await orchestrator.drain();
  const result = orchestrator.getJob('alice', job.id);
  assert.equal(result.state, 'failed'); assert.doesNotMatch(JSON.stringify(result), /secret-value|upstream/);
  assert.equal(store.counts('alice').total, 1);
  failure = false; const retry = orchestrator.enqueueSync('alice', 'github'); await orchestrator.drain();
  assert.equal(orchestrator.getJob('alice', retry.id).state, 'succeeded'); assert.equal(store.counts('alice').total, 0);
});

test('duplicate jobs coalesce; user mutations serialize behind ingestion', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { store, orchestrator } = setup({ config: { ...config(), githubToken: 's' }, connectors: {
    github: async () => { await gate; return { entries: [entry('2')], complete: true, warnings: [] }; },
  } }); t.after(() => store.close());
  const first = orchestrator.enqueueSync('alice', 'github'); const second = orchestrator.enqueueSync('alice', 'github');
  assert.equal(first.id, second.id);
  const mutation = orchestrator.importEntries('alice', [entry('3')]);
  release(); await mutation; await orchestrator.drain();
  assert.deepEqual(store.list('alice').map(x => x.id), ['github:2', 'github:3']);
});

test('invalid replacement is atomic and content changes invalidate reused embeddings', t => {
  const store = new Store(); t.after(() => store.close());
  const embedded = { ...entry(), embedding: { model: 'test', vector: [1, 0], hash: 'a'.repeat(64) } };
  store.writeEntries('alice', [embedded]);
  assert.throws(() => store.writeEntries('alice', [{ ...entry('2'), url: 'javascript:alert(1)' }], { replaceSource: 'github' }));
  assert.equal(store.counts('alice').total, 1);
  store.writeEntries('alice', [entry()]); assert.ok(store.list('alice')[0].embedding);
  store.writeEntries('alice', [{ ...entry(), text: 'New content' }]); assert.equal(store.list('alice')[0].embedding, undefined);
});

test('SQLite persists entries and interrupted jobs recover without automatically repeating external requests', t => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new Store(join(dir, 'test.sqlite'));
  store.writeEntries('alice', [entry()]);
  store.saveJob('alice', { id: 'interrupted', kind: 'index', state: 'running' }); store.close();
  store = new Store(join(dir, 'test.sqlite')); t.after(() => store.close());
  new Orchestrator({ store, config: config() });
  assert.equal(store.counts('alice').total, 1); assert.equal(store.getJob('alice', 'interrupted').state, 'failed');
});

test('demo mode ignores real credentials and stays in a separate database', () => {
  const loaded = loadConfig({ GITHUB_TOKEN: 'secret', JEV_API_KEY: 'secret', EMBEDDING_BASE_URL: 'https://secret', RECALL_DB: '/some/real.sqlite' }, { demo: true });
  assert.equal(loaded.githubToken, ''); assert.equal(loaded.jevConfig.apiKey, ''); assert.equal(loaded.embeddingConfig, null);
  assert.ok(loaded.dbPath.endsWith('/data/demo.sqlite'));
});

test('loopback HTTP serves real search; protects private endpoints; rejects injected identities, origins and Host rebinding', async t => {
  const { store, orchestrator } = setup(); await orchestrator.importEntries('local', [entry()]);
  const server = makeServer({ orchestrator });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/status`)).status, 403);
  const headers = { 'x-recall-client': 'local', 'content-type': 'application/json' };
  const response = await fetch(`${base}/api/search`, { method: 'POST', headers, body: JSON.stringify({ query: 'PDF' }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).results[0].id, 'github:1');
  assert.equal((await fetch(`${base}/api/search`, { method: 'POST', headers, body: JSON.stringify({ query: 'PDF', userId: 'bob' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/status`, { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/status`, { headers: { ...headers, host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(`${base}/api/search`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/api/search`, { method: 'POST', headers, body: JSON.stringify({ query: 'PDF', limit: 500 }) })).status, 400);
});


test('configured embeddings and Jev compose end-to-end across languages with independently scoped candidates', async t => {
  let embeddings = 0; let evaluations = 0;
  const searchWorker = new SearchWorker({ embeddingConfig: { baseUrl: 'https://embeddings.example/v1', apiKey: 'test-key', model: 'fixture-model' },
    fetchImpl: async (_url, options) => {
      embeddings++;
      const { input } = JSON.parse(options.body);
      return Response.json({ data: input.map((text, index) => ({ index, embedding: text.includes('Animation') ? [0, 1] : [1, 0] })) });
    },
  });
  const jevWorker = new JevWorker({ apiKey: 'test-key', fetchImpl: async (_url, options) => {
    evaluations++; const payload = JSON.parse(options.body); assert.ok(payload.state.includes('belgeden sayıları al'));
    return Response.json({ answers: { relevance: { type: 'score', score: 3, confidence: 0.9, probabilities: { '0': 0, '1': 0, '2': 0, '3': 1 } } } });
  } });
  const { store, orchestrator } = setup({ searchWorker, jevWorker }); t.after(() => store.close());
  await orchestrator.importEntries('alice', [entry('pdf', 'PDF table extractor'), { ...entry('animation', 'Animation'), text: 'Animation transitions' }]);
  await orchestrator.importEntries('bob', [entry('private', 'PDF private')]);
  const job = orchestrator.enqueueIndex('alice'); await orchestrator.drain();
  assert.equal(orchestrator.getJob('alice', job.id).result.indexed, 2);
  const result = await orchestrator.search('alice', { query: 'belgeden sayıları al' });
  assert.deepEqual(result.mode, { retrieval: 'hybrid', ranking: 'jev' });
  assert.deepEqual(result.results.map(r => r.id), ['github:pdf']);
  assert.equal(result.results[0].relevanceScore, 1); assert.equal(evaluations, 1);
  assert.ok(!JSON.stringify(result).includes('test-key')); assert.ok(!JSON.stringify(result).includes('vector'));
  const again = orchestrator.enqueueIndex('alice'); await orchestrator.drain();
  assert.equal(orchestrator.getJob('alice', again.id).state, 'succeeded'); assert.equal(embeddings, 2);
});
