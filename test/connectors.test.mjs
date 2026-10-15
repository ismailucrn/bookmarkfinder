import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGithubStars, fetchXBookmarks } from '../src/workers/connectors.mjs';

const TOKEN = 'secret-provider-token';
const repo = (id, extras = {}) => ({ id, full_name: `owner/repo-${id}`, description: 'Python PDF extraction', language: 'Python', topics: ['pdf'], updated_at: '2026-10-01T12:00:00Z', ...extras });
const json = (data, options) => new Response(JSON.stringify(data), options);
const post = (id, text = 'Local analytics tool') => ({ id: String(id), text, created_at: '2026-10-01T12:00:00Z', lang: 'en' });
const xpage = (posts, next, extra = {}) => ({ data: posts, meta: { result_count: posts.length, ...(next ? { next_token: next } : {}) }, ...extra });
function assertReadOnly(url, options, origin) {
  assert.equal(new URL(url).origin, origin);
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(options.signal instanceof AbortSignal, true);
}

test('GitHub paginates without following server links; enriches and deduplicates records', async () => {
  const requests = [];
  const result = await fetchGithubStars({ token: TOKEN, fetchImpl: async (url, options) => {
    requests.push(url);
    assertReadOnly(url, options, 'https://api.github.com');
    if (url.includes('/readme')) return new Response('# Fast extraction');
    assert.equal(options.headers.Accept, 'application/vnd.github.star+json');
    if (new URL(url).searchParams.get('page') === '1') return json([{ repo: repo(1), starred_at: '2026-09-01T01:00:00Z' }], { headers: { link: '<https://api.github.com/user/starred?page=2&per_page=100>; rel="next"' } });
    return json([repo(1), repo(2)]);
  } });
  assert.equal(result.complete, true);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].savedAt, '2026-09-01T01:00:00.000Z');
  assert.equal(result.entries[1].savedAt, null);
  assert.match(result.entries[0].text, /Fast extraction/);
  assert.equal(result.entries[0].metadata.readmeIncluded, true);
  assert.equal(requests.length, 5);
});

test('GitHub ignores provider URLs and refuses hostile pagination before credentials can leave', async () => {
  const calls = [];
  const result = await fetchGithubStars({ token: TOKEN, fetchImpl: async (url, options) => {
    assertReadOnly(url, options, 'https://api.github.com');
    calls.push(url);
    return url.includes('/readme') ? new Response('readme') : json([repo(1, { url: 'http://127.0.0.1/private', html_url: 'https://evil.test', download_url: 'https://evil.test' })], { headers: { link: '<https://evil.test/user/starred?page=2>; rel="next"' } });
  } });
  assert.equal(result.complete, false);
  assert.equal(result.entries[0].url, 'https://github.com/owner/repo-1');
  assert.equal(calls.length, 2);
  assert.match(result.warnings.join(' '), /unsafe pagination/);
});

test('GitHub limits list pages, README count and README bytes', async () => {
  let lists = 0;
  let readmes = 0;
  let active = 0;
  let peak = 0;
  const result = await fetchGithubStars({ token: TOKEN, fetchImpl: async url => {
    if (url.includes('/readme')) {
      readmes++;
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return new Response('r'.repeat(70_000));
    }
    const page = lists++;
    return json(Array.from({ length: 100 }, (_, i) => repo(page * 100 + i + 1)));
  } });
  assert.equal(lists, 10);
  assert.equal(readmes, 100);
  assert.equal(peak, 4);
  assert.equal(result.entries.length, 1000);
  assert.equal(result.complete, false);
  assert.equal(result.entries[100].metadata.readmeIncluded, false);
  assert.ok(result.entries[0].text.length < 66_000);
  assert.match(result.warnings.join(' '), /64 KiB/);
  assert.match(result.warnings.join(' '), /limited to the newest 100/);
});

test('GitHub README unavailable is explicit degraded enrichment, not list truncation', async () => {
  let count = 0;
  const result = await fetchGithubStars({ token: TOKEN, fetchImpl: async url => {
    if (!url.includes('/readme')) return json([repo(1), repo(2)]);
    return ++count === 1 ? new Response('', { status: 404 }) : new Response(`body ${TOKEN}`, { status: 403 });
  } });
  assert.equal(result.complete, true);
  assert.ok(result.entries.every(e => !e.metadata.readmeIncluded));
  assert.match(result.warnings.join(' '), /could not be fetched/);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('GitHub malformed repository cannot form a path traversal request or a complete snapshot', async () => {
  const calls = [];
  const result = await fetchGithubStars({ token: TOKEN, fetchImpl: async url => {
    calls.push(url);
    return json([repo(1, { full_name: 'owner/..' }), repo(2, { full_name: '../secret' }), repo(3, { id: 9007199254740992 })]);
  } });
  assert.equal(result.complete, false);
  assert.deepEqual(result.entries, []);
  assert.equal(calls.length, 1);
});

test('GitHub a repeated full page stops pagination safely', async () => {
  let pages = 0;
  const result = await fetchGithubStars({ token: TOKEN, fetchImpl: async url => {
    if (url.includes('/readme')) return new Response('', { status: 404 });
    pages++;
    return json(Array.from({ length: 100 }, (_, i) => repo(i + 1)));
  } });
  assert.equal(pages, 2);
  assert.equal(result.complete, false);
  assert.match(result.warnings.join(' '), /repeated a page/);
});

test('X paginates opaque cursors using fixed host and preserves published versus saved dates', async () => {
  const calls = [];
  const result = await fetchXBookmarks({ token: TOKEN, userId: '1234', fetchImpl: async (url, options) => {
    assertReadOnly(url, options, 'https://api.x.com');
    calls.push(url);
    if (calls.length === 1) return json(xpage([post(1)], 'cursor+&next'));
    assert.equal(new URL(url).searchParams.get('pagination_token'), 'cursor+&next');
    return json(xpage([post(1), { ...post(2), note_tweet: { text: 'Full long post text' } } ]));
  } });
  assert.equal(calls.length, 2);
  assert.equal(result.complete, true);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].savedAt, null);
  assert.equal(result.entries[0].metadata.publishedAt, '2026-10-01T12:00:00.000Z');
  assert.equal(result.entries[1].text, 'Full long post text');
});

test('X empty account is a valid complete empty snapshot', async () => {
  const result = await fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl: async () => json({ meta: { result_count: 0 } }) });
  assert.deepEqual(result, { entries: [], complete: true, warnings: [] });
});

test('X partial errors preserve entries but cannot replace snapshot', async () => {
  const result = await fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl: async () => json(xpage([post(2)], null, { errors: [{ detail: TOKEN }] })) });
  assert.equal(result.complete, false);
  assert.equal(result.entries.length, 1);
  assert.match(result.warnings.join(' '), /partial API errors/);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('X repeated cursor stops with incomplete signal and page limit is bounded', async () => {
  let calls = 0;
  const repeated = await fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl: async () => json(xpage([post(++calls)], 'same')) });
  assert.equal(calls, 2);
  assert.equal(repeated.complete, false);
  calls = 0;
  const limited = await fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl: async () => json(xpage([post(++calls)], `cursor${calls}`)) });
  assert.equal(calls, 10);
  assert.equal(limited.complete, false);
  assert.match(limited.warnings.join(' '), /pagination limit/);
});

test('X invalid posts never silently become complete or unsafe links', async () => {
  const result = await fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl: async () => json(xpage([post('../private'), { id: '2' }])) });
  assert.equal(result.complete, false);
  assert.deepEqual(result.entries, []);
});

test('all provider failure messages discard bodies, raw exception details and credentials', async () => {
  for (const provider of [fetchGithubStars, fetchXBookmarks]) {
    for (const fetchImpl of [async () => { throw new Error(`leak ${TOKEN}`); }, async () => new Response(`leak ${TOKEN}`, { status: 429 }), async () => new Response(`malformed ${TOKEN}`)]) {
      await assert.rejects(provider({ token: TOKEN, userId: '1', fetchImpl }), error => {
        assert.ok(!error.message.includes(TOKEN));
        assert.ok(!error.stack.includes(TOKEN));
        assert.match(error.message, /ingestion failed/);
        return true;
      });
    }
  }
});

test('credentials echoed by provider in whitelisted free text are redacted', async () => {
  const github = await fetchGithubStars({ token: TOKEN, fetchImpl: async url => url.includes('/readme') ? new Response(`README ${TOKEN}`) : json([repo(1, { description: TOKEN, language: TOKEN, topics: [TOKEN], temp_clone_token: TOKEN })]) });
  const x = await fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl: async () => json(xpage([post(2, TOKEN)])) });
  assert.ok(!JSON.stringify(github).includes(TOKEN));
  assert.ok(!JSON.stringify(x).includes(TOKEN));
  assert.match(github.entries[0].text, /REDACTED/);
});

test('invalid authentication/user ID and cancellation make no requests', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected'); };
  await assert.rejects(fetchGithubStars({ token: 'bad\r\nheader', fetchImpl }));
  await assert.rejects(fetchXBookmarks({ token: TOKEN, userId: '123/../../private', fetchImpl }));
  await assert.rejects(fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl, signal: AbortSignal.abort() }));
  await assert.rejects(fetchGithubStars({ token: TOKEN, fetchImpl, signal: AbortSignal.abort() }));
  assert.equal(calls, 0);
});

test('oversized or structurally invalid list responses fail safely', async () => {
  await assert.rejects(fetchGithubStars({ token: TOKEN, fetchImpl: async () => new Response(' '.repeat(2 * 1024 * 1024 + 1)) }), /network or invalid response/);
  await assert.rejects(fetchGithubStars({ token: TOKEN, fetchImpl: async () => json({ items: [] }) }), /invalid stars response/);
  await assert.rejects(fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl: async () => json({}) }), /invalid bookmarks response/);
});

test('X inconsistent result counts cannot certify an empty snapshot', async () => {
  const result = await fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl: async () => json({ data: [], meta: { result_count: 100 } }) });
  assert.equal(result.complete, false);
  assert.match(result.warnings.join(' '), /inconsistent pagination counts/);
});

test('a later page API failure throws instead of returning a replaceable partial snapshot', async () => {
  let calls = 0;
  await assert.rejects(fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl: async () => ++calls === 1 ? json(xpage([post(1)], 'next')) : new Response(TOKEN, { status: 401 }) }), /X ingestion failed: HTTP 401/);
});

test('cancellation during README enrichment cannot be swallowed as optional enrichment', async () => {
  const controller = new AbortController();
  await assert.rejects(fetchGithubStars({ token: TOKEN, signal: controller.signal, fetchImpl: async url => {
    if (!url.includes('/readme')) return json([repo(1)]);
    controller.abort();
    throw new Error(TOKEN);
  } }), /request cancelled/);
});

test('X prefers current post fields and current long-post response text', async () => {
  let calls = 0;
  const result = await fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl: async (url, options) => {
    calls++;
    assertReadOnly(url, options, 'https://api.x.com');
    assert.equal(new URL(url).searchParams.get('post.fields'), 'created_at,lang,note_post');
    assert.equal(new URL(url).searchParams.has('tweet.fields'), false);
    return json(xpage([{ ...post(1), note_post: { text: 'Current long text' }, note_tweet: { text: 'Legacy text' } }]));
  } });
  assert.equal(calls, 1);
  assert.equal(result.entries[0].text, 'Current long text');
  assert.deepEqual(result.warnings, []);
});

test('X performs one HTTP 400 compatibility fallback and retains legacy spelling for later pages', async () => {
  const calls = [];
  const result = await fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl: async (url, options) => {
    assertReadOnly(url, options, 'https://api.x.com');
    const query = new URL(url).searchParams;
    calls.push(query);
    if (calls.length === 1) return new Response(`private body ${TOKEN}`, { status: 400 });
    assert.equal(query.get('tweet.fields'), 'created_at,lang,note_tweet');
    assert.equal(query.has('post.fields'), false);
    return calls.length === 2 ? json(xpage([post(1)], 'opaque+cursor')) : json(xpage([post(2)]));
  } });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].has('post.fields'), true);
  assert.equal(calls[1].has('pagination_token'), false);
  assert.equal(calls[2].get('pagination_token'), 'opaque+cursor');
  assert.equal(result.complete, true);
  assert.match(result.warnings.join(' '), /legacy tweet.fields compatibility/);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('X can switch on a later page without losing or modifying its cursor', async () => {
  let calls = 0;
  const result = await fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl: async url => {
    calls++;
    const query = new URL(url).searchParams;
    if (calls === 1) return json(xpage([post(1)], 'second+&page'));
    assert.equal(query.get('pagination_token'), 'second+&page');
    if (calls === 2) {
      assert.equal(query.has('post.fields'), true);
      return new Response('', { status: 400 });
    }
    assert.equal(query.has('tweet.fields'), true);
    return json(xpage([post(2)]));
  } });
  assert.equal(calls, 3);
  assert.deepEqual(result.entries.map(entry => entry.externalId), ['1', '2']);
});

test('X compatibility never loops or retries authorization, billing, rate-limit or network failures', async () => {
  for (const status of [400, 401, 403, 402, 429, 500, null]) {
    let calls = 0;
    await assert.rejects(fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl: async () => {
      calls++;
      if (status === null) throw new Error(`private ${TOKEN}`);
      return new Response(`private ${TOKEN}`, { status });
    } }), error => !error.message.includes(TOKEN));
    assert.equal(calls, status === 400 ? 2 : 1);
  }
});

test('X fallback adds at most one request to the ten-page ingestion budget', async () => {
  let calls = 0;
  let pages = 0;
  const result = await fetchXBookmarks({ token: TOKEN, userId: '1', fetchImpl: async () => {
    if (++calls === 1) return new Response('', { status: 400 });
    pages++;
    return json(xpage([post(pages)], `next${pages}`));
  } });
  assert.equal(calls, 11);
  assert.equal(pages, 10);
  assert.equal(result.complete, false);
});

test('GitHub first-page ID changes or reordering during pagination invalidate the snapshot', async () => {
  for (const changed of [[repo(9), repo(1)], [repo(2), repo(1)]]) {
    let lists = 0;
    let firstPageCalls = 0;
    const result = await fetchGithubStars({ token: TOKEN, fetchImpl: async (url, options) => {
      assertReadOnly(url, options, 'https://api.github.com');
      if (url.includes('/readme')) return new Response('', { status: 404 });
      lists++;
      if (new URL(url).searchParams.get('page') === '2') return json([repo(3)]);
      const data = ++firstPageCalls === 1 ? [repo(1), repo(2)] : changed;
      return json(data, { headers: { link: '<https://api.github.com/user/starred?page=2>; rel="next"' } });
    } });
    assert.equal(lists, 3);
    assert.equal(firstPageCalls, 2);
    assert.equal(result.complete, false);
    assert.match(result.warnings.join(' '), /stars changed during pagination/);
  }
});

test('GitHub detects changed last-page count even when first-page IDs stay stable', async () => {
  let firstPageCalls = 0;
  const result = await fetchGithubStars({ token: TOKEN, fetchImpl: async url => {
    if (url.includes('/readme')) return new Response('', { status: 404 });
    if (new URL(url).searchParams.get('page') === '2') return json([repo(2)]);
    const last = ++firstPageCalls === 1 ? 2 : 3;
    return json([repo(1)], { headers: { link: `<https://api.github.com/user/starred?page=2>; rel="next", <https://api.github.com/user/starred?page=${last}>; rel="last"` } });
  } });
  assert.equal(firstPageCalls, 2);
  assert.equal(result.complete, false);
});

test('GitHub a failed first-page verification cannot return a replaceable snapshot', async () => {
  let calls = 0;
  await assert.rejects(fetchGithubStars({ token: TOKEN, fetchImpl: async () => {
    calls++;
    if (calls === 1) return json([repo(1)], { headers: { link: '<https://api.github.com/user/starred?page=2>; rel="next"' } });
    if (calls === 2) return json([repo(2)]);
    return new Response(TOKEN, { status: 403 });
  } }), /GitHub ingestion failed: HTTP 403/);
  assert.equal(calls, 3);
});
