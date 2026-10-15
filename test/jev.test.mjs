import test from 'node:test';
import assert from 'node:assert/strict';
import { JevWorker } from '../src/workers/jev.mjs';

const candidate = (id) => ({ entry: { id, title: id, text: 'PDF extraction content' }, retrievalScore: 1, lexicalScore: 1, semanticScore: null });
function response(score = 3, confidence = 1) {
  const probabilities = { 0: 0, 1: 0, 2: 0, 3: 0 };
  probabilities[Math.floor(score)] = 1 - (score % 1);
  if (score % 1) probabilities[Math.ceil(score)] = score % 1;
  return Response.json({ answers: { relevance: { type: 'score', score, confidence, probabilities } } });
}

test('unconfigured mode makes no external requests and retains retrieval order', async () => {
  const candidates = [candidate('a'), candidate('b')];
  const worker = new JevWorker({ fetchImpl: () => { throw new Error('must not call'); } });
  const result = await worker.rank({ query: 'PDF', candidates });
  assert.equal(result.mode, 'retrieval');
  assert.deepEqual(result.results.map((r) => r.entry.id), ['a', 'b']);
  assert.ok(result.warnings[0].includes('not configured'));
  assert.equal(result.results[0].relevanceScore, null);
  assert.equal(candidates[0].rankingMethod, undefined);
});

test('official Score request ranks by relevance, never by confidence, with stable ties', async () => {
  const candidates = [candidate('low'), candidate('best'), candidate('tie')];
  let calls = 0;
  const worker = new JevWorker({ apiKey: 'secret', fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer secret');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'jev-latest');
    assert.equal(body.questions.relevance.type, 'score');
    assert.equal(body.questions.relevance.criteria.length, 4);
    const state = JSON.parse(body.state);
    assert.equal(state.user_query, 'PDF');
    return response(state.candidate.title === 'low' ? 0 : 2.5, state.candidate.title === 'low' ? 1 : 0.2);
  }});
  const result = await worker.rank({ query: 'PDF', candidates });
  assert.equal(calls, 3);
  assert.equal(result.mode, 'jev');
  assert.deepEqual(result.results.map((r) => r.entry.id), ['best', 'tie', 'low']);
  assert.equal(result.results[0].relevanceScore, 2.5 / 3);
  assert.equal(result.results[0].confidence, 0.2);
  assert.equal(result.results[0].explanation, undefined);
});

test('partial provider failure falls back for the entire result set without secrets', async () => {
  const worker = new JevWorker({ apiKey: 'SECRET', fetchImpl: async (_, options) => {
    if (JSON.parse(JSON.parse(options.body).state).candidate.title === 'bad') throw new Error('SECRET upstream details');
    return response();
  }});
  const result = await worker.rank({ query: 'PDF', candidates: [candidate('a'), candidate('bad'), candidate('c')] });
  assert.equal(result.mode, 'retrieval');
  assert.deepEqual(result.results.map((r) => r.entry.id), ['a', 'bad', 'c']);
  assert.ok(result.results.every((r) => r.relevanceScore === null && r.confidence === null));
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('rejects malformed provider values and distributions into full fallback', async () => {
  const invalid = [
    { score: '3' }, { score: NaN }, { score: -1 }, { score: 3.1 },
    { confidence: null }, { confidence: 1.1 }, { type: 'choice' },
    { probabilities: { 0: 0, 1: 0, 2: 0, 3: 0.3 } },
    { probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 } },
    { probabilities: { 0: -0.1, 1: 0.1, 2: 0, 3: 1 } },
    { probabilities: { 0: 0, 1: 0, 2: 0, 3: 1, extra: 0 } },
  ];
  for (const patch of invalid) {
    const worker = new JevWorker({ apiKey: 'key', fetchImpl: async () => Response.json({ answers: { relevance: { type: 'score', score: 3, confidence: 1, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 }, ...patch } } }) });
    assert.equal((await worker.rank({ query: 'PDF', candidates: [candidate('a')] })).mode, 'retrieval');
  }
});

test('HTTP and JSON failures are sanitized', async () => {
  for (const fetchImpl of [async () => new Response('SECRET', { status: 500 }), async () => new Response('SECRET invalid JSON')]) {
    const worker = new JevWorker({ apiKey: 'SECRET', fetchImpl });
    const result = await worker.rank({ query: 'PDF', candidates: [candidate('a')] });
    assert.equal(result.mode, 'retrieval');
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});

test('timeouts abort hanging requests and use retrieval fallback', async () => {
  let signal;
  const worker = new JevWorker({ apiKey: 'key', timeoutMs: 10, fetchImpl: async (_, options) => { signal = options.signal; return new Promise(() => {}); } });
  const result = await worker.rank({ query: 'PDF', candidates: [candidate('a')] });
  assert.equal(result.mode, 'retrieval');
  assert.equal(signal.aborted, true);
});

test('candidate cap, content cap and concurrency bound apply', async () => {
  let active = 0, peak = 0, calls = 0;
  const worker = new JevWorker({ apiKey: 'key', concurrency: 3, fetchImpl: async (_, options) => {
    calls++; active++; peak = Math.max(peak, active);
    const state = JSON.parse(JSON.parse(options.body).state);
    assert.ok(state.candidate.content.length <= 12_000);
    assert.ok(state.candidate.title.length <= 500);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--; return response();
  }});
  const candidates = Array.from({ length: 60 }, (_, index) => candidate(String(index)));
  candidates[0].entry.text = 'x'.repeat(20_000);
  const result = await worker.rank({ query: 'PDF', candidates, limit: 10 });
  assert.equal(calls, 50);
  assert.equal(peak, 3);
  assert.equal(result.results.length, 10);
  assert.equal(result.warnings.length, 2);
});

test('rejects unsafe configuration and invalid caller inputs', async () => {
  assert.throws(() => new JevWorker({ baseUrl: 'https://gateway.example/v1' }), /official/);
  assert.throws(() => new JevWorker({ concurrency: 9 }), /limits/);
  const worker = new JevWorker();
  await assert.rejects(worker.rank({ query: '', candidates: [] }), /input/);
  await assert.rejects(worker.rank({ query: 'PDF', candidates: [], limit: 0 }), /input/);
  await assert.rejects(worker.rank({ query: 'PDF', candidates: [{}] }), /candidates/);
});


test('oversized declared and streamed responses are cancelled and fall back before JSON parsing', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(80 * 1024).fill(32)); },
      cancel() { cancelled = true; },
    });
    const worker = new JevWorker({ apiKey: 'key', fetchImpl: async () => new Response(stream, {
      headers: declared ? { 'content-length': String(129 * 1024) } : {},
    }) });
    const result = await worker.rank({ query: 'PDF', candidates: [candidate('a')] });
    assert.equal(result.mode, 'retrieval');
    assert.equal(cancelled, true);
  }
});

test('request deadline also cancels a stalled response body', async () => {
  let cancelled = false;
  const worker = new JevWorker({ apiKey: 'key', timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({
    pull() {}, cancel() { cancelled = true; },
  })) });
  const result = await worker.rank({ query: 'PDF', candidates: [candidate('a')] });
  assert.equal(result.mode, 'retrieval');
  assert.equal(cancelled, true);
});
