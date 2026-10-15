/** Read-only, fixed-origin provider ingestion. No credential is persisted or logged. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_READMES = 100;
const README_BYTES = 64 * 1024;
const JSON_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

function fail(provider, detail) { return new Error(`${provider} ingestion failed: ${detail}.`); }
function validate(token, fetchImpl, provider) {
  if (typeof token !== 'string' || !token || token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(token)) {
    throw fail(provider, 'a valid user access token is required');
  }
  if (typeof fetchImpl !== 'function') throw fail(provider, 'fetch is unavailable');
}
function cancelled(signal, provider) {
  if (signal?.aborted) throw fail(provider, 'request cancelled');
}
function string(value, limit = 4000) { return typeof value === 'string' ? value.slice(0, limit) : ''; }
function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;
}
function identifier(value, max = 30) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const id = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  return new RegExp(`^[0-9]{1,${max}}$`).test(id) ? id : null;
}
function redact(value, token) {
  if (typeof value === 'string') return value.replaceAll(token, '[REDACTED]');
  if (Array.isArray(value)) return value.map(item => redact(item, token));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, token)]));
  return value;
}

async function boundedText(response, bytes, truncate = false) {
  if (!response.body?.getReader) {
    const text = await response.text();
    const buffer = Buffer.from(text);
    if (buffer.length > bytes && !truncate) throw new Error('oversized');
    return { text: buffer.subarray(0, bytes).toString('utf8'), truncated: buffer.length > bytes };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = bytes - total;
      if (value.byteLength > remaining) {
        if (!truncate) throw new Error('oversized');
        chunks.push(value.subarray(0, remaining));
        total = bytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Do not await cancellation of an untrusted producer.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks, total).toString('utf8'), truncated };
}

async function request({ url, token, provider, fetchImpl, signal, raw = false }) {
  cancelled(signal, provider);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'error', signal: combined,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : provider === 'GitHub' ? 'application/vnd.github.star+json' : 'application/json',
        ...(provider === 'GitHub' ? { 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Recall-local-MVP' } : {}),
      },
    });
    const status = Number(response.status);
    if (raw && status === 404) { response.body?.cancel?.().catch(() => {}); return { missing: true }; }
    if (!response.ok || response.redirected || status >= 300) {
      response.body?.cancel?.().catch(() => {});
      throw fail(provider, Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP ${status}` : 'invalid HTTP response');
    }
    const body = await boundedText(response, raw ? README_BYTES : JSON_BYTES, raw);
    if (combined.aborted) throw fail(provider, signal?.aborted ? 'request cancelled' : 'request timed out');
    return raw ? body : { data: JSON.parse(body.text), link: response.headers?.get('link') || '' };
  } catch (error) {
    if (signal?.aborted) throw fail(provider, 'request cancelled');
    if (timeout.aborted) throw fail(provider, 'request timed out');
    // Only propagate error strings constructed here; never upstream bodies or exceptions.
    if (error instanceof Error && /^\w+ ingestion failed: HTTP \d{3}\.$/.test(error.message)) throw error;
    throw fail(provider, 'network or invalid response');
  }
}

function githubEntry(item, now) {
  const repo = item?.repo ?? item;
  const id = identifier(repo?.id);
  const name = repo?.full_name;
  if (!id || typeof name !== 'string' || !/^[a-z\d][a-z\d-]{0,99}\/[a-z\d._-]{1,100}$/i.test(name) || ['.', '..'].includes(name.split('/')[1])) return null;
  const topics = Array.isArray(repo.topics) ? repo.topics.filter(x => typeof x === 'string').slice(0, 30).map(x => x.slice(0, 100)) : [];
  const language = string(repo.language, 100) || null;
  return {
    id: `github:${id}`, source: 'github', externalId: id,
    url: `https://github.com/${name}`, title: name,
    text: [name, string(repo.description, 8000), language, topics.join(' ')].filter(Boolean).join('\n'),
    metadata: { language, topics, archived: repo.archived === true, readmeIncluded: false },
    savedAt: date(item?.starred_at), updatedAt: date(repo.updated_at) || now,
  };
}

// Read Link only as a pagination signal. Reconstruct every next URL ourselves.
function githubNext(link, page, length) {
  if (!link) return length === PAGE_SIZE ? 'next' : 'end';
  const next = link.split(',').find(part => /;\s*rel\s*=\s*["']?next["']?(?:\s|;|$)/i.test(part));
  if (!next) return 'end';
  try {
    const address = new URL(next.match(/<([^>]+)>/)[1]);
    return address.origin === 'https://api.github.com' && address.pathname === '/user/starred' && !address.username && !address.password
      && address.searchParams.get('page') === String(page + 1) ? 'next' : 'invalid';
  } catch { return 'invalid'; }
}

// Detect common offset-pagination drift without claiming an atomic provider snapshot.
function githubFirstPageFingerprint(data, link) {
  let last = null;
  const part = link.split(',').find(value => /;\s*rel\s*=\s*["']?last["']?(?:\s|;|$)/i.test(value));
  if (part) {
    try {
      const url = new URL(part.match(/<([^>]+)>/)[1]);
      if (url.origin === 'https://api.github.com' && url.pathname === '/user/starred') {
        const value = url.searchParams.get('page');
        if (/^[1-9]\d{0,8}$/.test(value)) last = Number(value);
      }
    } catch { /* No URL from this signal is ever fetched. */ }
  }
  return JSON.stringify({ ids: data.map(item => identifier((item?.repo ?? item)?.id)),
    next: githubNext(link, 1, data.length), last });
}

export async function fetchGithubStars({ token, fetchImpl = globalThis.fetch, signal } = {}) {
  const provider = 'GitHub';
  validate(token, fetchImpl, provider);
  const warnings = new Set();
  const entries = [];
  const ids = new Set();
  const now = new Date().toISOString();
  let complete = true;
  let pageCount = 0;
  let firstPageFingerprint;
  const starsUrl = page => `https://api.github.com/user/starred?per_page=${PAGE_SIZE}&page=${page}&sort=created&direction=desc`;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = starsUrl(page);
    pageCount++;
    const { data, link } = await request({ url, token, provider, fetchImpl, signal });
    if (!Array.isArray(data)) throw fail(provider, 'invalid stars response');
    if (page === 1) firstPageFingerprint = githubFirstPageFingerprint(data, link);
    if (data.length > PAGE_SIZE) { complete = false; warnings.add('GitHub returned more than the requested page size; snapshot is incomplete.'); }
    let added = 0;
    for (const item of data.slice(0, PAGE_SIZE)) {
      const entry = githubEntry(item, now);
      if (!entry) { complete = false; warnings.add('GitHub returned an invalid repository; snapshot is incomplete.'); continue; }
      if (!ids.has(entry.id)) { ids.add(entry.id); entries.push(entry); added++; }
    }
    const next = githubNext(link, page, data.length);
    if (next === 'invalid') { complete = false; warnings.add('GitHub returned an unsafe pagination link; snapshot is incomplete.'); break; }
    if (next === 'end') break;
    if (!added) { complete = false; warnings.add('GitHub pagination repeated a page; snapshot is incomplete.'); break; }
    if (page === MAX_PAGES) { complete = false; warnings.add('GitHub pagination limit reached (10 pages / 1,000 repositories); snapshot is incomplete.'); }
  }
  if (complete && pageCount > 1) {
    const { data, link } = await request({ url: starsUrl(1), token, provider, fetchImpl, signal });
    if (!Array.isArray(data)) throw fail(provider, 'invalid stars verification response');
    if (githubFirstPageFingerprint(data, link) !== firstPageFingerprint) {
      complete = false;
      warnings.add('GitHub stars changed during pagination; snapshot is incomplete. Retry synchronization when saves are stable.');
    }
  }
  if (entries.length > MAX_READMES) warnings.add('GitHub README enrichment is limited to the newest 100 repositories; other entries use repository metadata.');
  let index = 0;
  const enrichment = async () => {
    while (index < Math.min(entries.length, MAX_READMES)) {
      const entry = entries[index++];
      const url = `https://api.github.com/repos/${entry.title.split('/').map(encodeURIComponent).join('/')}/readme`;
      try {
        const readme = await request({ url, token, provider, fetchImpl, signal, raw: true });
        if (readme.missing) continue;
        entry.text += `\n\n${readme.text}`;
        entry.metadata.readmeIncluded = true;
        if (readme.truncated) warnings.add('Some GitHub READMEs were truncated to 64 KiB.');
      } catch {
        cancelled(signal, provider);
        warnings.add('Some GitHub READMEs could not be fetched; those entries use repository metadata.');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, enrichment));
  cancelled(signal, provider);
  return { entries: redact(entries, token), complete, warnings: [...warnings] };
}

export async function fetchXBookmarks({ token, userId, fetchImpl = globalThis.fetch, signal } = {}) {
  const provider = 'X';
  validate(token, fetchImpl, provider);
  const accountId = identifier(userId, 19);
  if (!accountId) throw fail(provider, 'a numeric authenticated user ID is required');
  const entries = [];
  const ids = new Set();
  const cursors = new Set();
  const warnings = new Set();
  const now = new Date().toISOString();
  let cursor;
  let legacyFields = false;
  let complete = true;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(`https://api.x.com/2/users/${accountId}/bookmarks`);
    url.searchParams.set('max_results', String(PAGE_SIZE));
    // Prefer the current reference. One HTTP 400 may switch this ingestion to the legacy spelling.
    url.searchParams.set(legacyFields ? 'tweet.fields' : 'post.fields', legacyFields ? 'created_at,lang,note_tweet' : 'created_at,lang,note_post');
    if (cursor) url.searchParams.set('pagination_token', cursor);
    let response;
    try {
      response = await request({ url: url.href, token, provider, fetchImpl, signal });
    } catch (error) {
      if (legacyFields || error.message !== 'X ingestion failed: HTTP 400.') throw error;
      legacyFields = true;
      url.searchParams.delete('post.fields');
      url.searchParams.set('tweet.fields', 'created_at,lang,note_tweet');
      warnings.add('X required legacy tweet.fields compatibility; remaining pages use that spelling.');
      response = await request({ url: url.href, token, provider, fetchImpl, signal });
    }
    const { data: body } = response;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !body.meta || typeof body.meta !== 'object'
        || Array.isArray(body.meta) || !Number.isInteger(body.meta.result_count) || body.meta.result_count < 0
        || (!Array.isArray(body.data) && !(body.data === undefined && body.meta.result_count === 0))) {
      throw fail(provider, 'invalid bookmarks response');
    }
    if (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length)) {
      complete = false; warnings.add('X returned partial API errors; snapshot is incomplete.');
    }
    const data = body.data ?? [];
    if (body.meta.result_count !== data.length) { complete = false; warnings.add('X returned inconsistent pagination counts; snapshot is incomplete.'); }
    if (data.length > PAGE_SIZE) { complete = false; warnings.add('X returned more than the requested page size; snapshot is incomplete.'); }
    for (const post of data.slice(0, PAGE_SIZE)) {
      const id = identifier(post?.id, 19);
      const text = typeof post?.note_post?.text === 'string' ? post.note_post.text : typeof post?.note_tweet?.text === 'string' ? post.note_tweet.text : post?.text;
      if (!id || typeof text !== 'string' || !text.trim()) { complete = false; warnings.add('X returned an invalid post; snapshot is incomplete.'); continue; }
      if (ids.has(id)) continue;
      ids.add(id);
      entries.push({ id: `x:${id}`, source: 'x', externalId: id, url: `https://x.com/i/web/status/${id}`,
        title: text.replace(/\s+/g, ' ').slice(0, 120), text: text.slice(0, 32_000),
        metadata: { language: string(post.lang, 20) || null, publishedAt: date(post.created_at) },
        savedAt: null, updatedAt: now });
    }
    const next = body.meta.next_token;
    if (next === undefined || next === null || next === '') break;
    if (typeof next !== 'string' || next.length > 2048 || /[\x00-\x20\x7f]/.test(next) || cursors.has(next)) {
      complete = false; warnings.add('X returned invalid or repeated pagination; snapshot is incomplete.'); break;
    }
    cursors.add(next);
    cursor = next;
    if (page === MAX_PAGES) { complete = false; warnings.add('X pagination limit reached (10 pages / 1,000 posts); snapshot is incomplete.'); }
  }
  cancelled(signal, provider);
  return { entries: redact(entries, token), complete, warnings: [...warnings] };
}
