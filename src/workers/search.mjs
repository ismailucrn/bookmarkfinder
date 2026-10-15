import { createHash } from 'node:crypto';

const MAX_INPUT_CHARS = 24000;
const BATCH_SIZE = 32;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const RRF_K = 60;
const STOPWORDS = new Set('a an and are as at be been by for from has have i in is it its of on or that the this to was were with you your bir bu da de diye en icin ile mi ne o olan olarak ve veya'.split(' '));
const DISABLED = 'Semantic search is disabled; results use lexical BM25 ranking.';
const UNAVAILABLE = 'Embedding service failed or returned invalid vectors; using lexical search.';

function content(entry) {
  return `${String(entry.title ?? '')}\n${String(entry.text ?? '')}`.slice(0, MAX_INPUT_CHARS);
}
function hashContent(entry) {
  return createHash('sha256').update(content(entry)).digest('hex');
}
function validVector(vector) {
  return Array.isArray(vector) && vector.length > 0 && vector.length <= 32768 &&
    vector.every(value => typeof value === 'number' && Number.isFinite(value)) &&
    Number.isFinite(Math.hypot(...vector)) && Math.hypot(...vector) > 0;
}
function tokens(text) {
  const normalized = String(text).normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/ı/g, 'i');
  const full = normalized.match(/[\p{L}\p{N}]+(?:\+\+|#)?(?:[.@/_+\-][\p{L}\p{N}]+(?:\+\+|#)?)*/gu) ?? [];
  // Keep package paths whole AND index components: exact package names remain searchable.
  return full.flatMap(token => {
    // A trailing language marker is part of the token: C++, C#, and C stay distinct.
    const parts = token.split(/[.@/_\-]|(?<=[\p{L}\p{N}])\+(?=[\p{L}\p{N}])/u).filter(Boolean);
    return (parts.length > 1 ? [token, ...new Set(parts)] : [token]).filter(part => !STOPWORDS.has(part));
  });
}
function lexicalRanking(query, entries) {
  const queryTerms = new Set(tokens(query));
  const documents = entries.map(entry => tokens(content(entry)));
  const frequencies = documents.map(terms => {
    const counts = new Map();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    return counts;
  });
  const averageLength = documents.reduce((total, terms) => total + terms.length, 0) / (entries.length || 1) || 1;
  const documentFrequency = new Map();
  for (const term of queryTerms) {
    documentFrequency.set(term, frequencies.filter(counts => counts.has(term)).length);
  }
  const k1 = 1.2;
  const b = 0.75;
  return entries.map((entry, index) => {
    let lexicalScore = 0;
    for (const term of queryTerms) {
      const tf = frequencies[index].get(term) ?? 0;
      if (!tf) continue;
      const df = documentFrequency.get(term);
      const idf = Math.log(1 + (entries.length - df + 0.5) / (df + 0.5));
      lexicalScore += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * documents[index].length / averageLength));
    }
    return { entry, index, lexicalScore, semanticScore: null, retrievalScore: lexicalScore };
  });
}
function cosine(left, right) {
  const leftNorm = Math.hypot(...left);
  const rightNorm = Math.hypot(...right);
  // Normalize before multiplying to avoid overflowing with finite large values.
  return Math.max(-1, Math.min(1, left.reduce((sum, value, i) => sum + (value / leftNorm) * (right[i] / rightNorm), 0)));
}
function stableSort(list, field) {
  return list.sort((a, b) => b[field] - a[field] || a.index - b.index);
}
function publicCandidates(list, limit) {
  return list.slice(0, limit).map(({ index, ...candidate }) => candidate);
}
function cleanLimit(limit) {
  return Number.isInteger(limit) ? Math.max(0, Math.min(limit, 200)) : 40;
}

async function boundedJson(response, signal) {
  const declaredLength = response.headers?.get('content-length');
  if (declaredLength !== null && declaredLength !== undefined && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    response.body?.cancel?.().catch(() => {});
    throw new Error('Embedding response is too large.');
  }
  // Require a stream so even chunked/unknown-length bodies are bounded before JSON parsing.
  // Injected fetch implementations should return a standard Response, as native fetch does.
  if (!response.body?.getReader) throw new Error('Invalid embedding response stream.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('Embedding response is too large.');
      chunks.push(value);
    }
    if (signal.aborted) throw new Error('Embedding request timed out.');
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class SearchWorker {
  constructor({ embeddingConfig = null, fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl;
    this.config = null;
    if (embeddingConfig) {
      let url;
      try { url = new URL(embeddingConfig.baseUrl); } catch { throw new Error('Invalid embeddings base URL.'); }
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
          url.username || url.password || url.search || url.hash || !embeddingConfig.model?.trim()) {
        throw new Error('Embeddings require an HTTPS base URL (HTTP allowed for loopback) and model name.');
      }
      this.config = {
        endpoint: `${url.href.replace(/\/$/, '')}/embeddings`,
        model: embeddingConfig.model,
        apiKey: embeddingConfig.apiKey ?? '',
      };
    }
  }

  async embed(input) {
    const headers = { 'content-type': 'application/json' };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    const signal = AbortSignal.timeout(15000);
    const response = await this.fetchImpl(this.config.endpoint, {
      method: 'POST', headers, redirect: 'error', signal,
      body: JSON.stringify({ model: this.config.model, input, encoding_format: 'float' }),
    });
    if (!response.ok || response.redirected) {
      response.body?.cancel?.().catch(() => {});
      throw new Error('Embedding request failed.');
    }
    const body = await boundedJson(response, signal);
    if (!Array.isArray(body.data) || body.data.length !== input.length) throw new Error('Invalid embedding response.');
    const ordered = new Array(input.length);
    for (const item of body.data) {
      if (!Number.isInteger(item.index) || item.index < 0 || item.index >= input.length || ordered[item.index] || !validVector(item.embedding)) {
        throw new Error('Invalid embedding response.');
      }
      ordered[item.index] = item.embedding;
    }
    if (ordered.some(vector => vector.length !== ordered[0].length)) throw new Error('Inconsistent embedding dimensions.');
    return ordered;
  }

  async indexEntries(entries) {
    const output = structuredClone(entries);
    if (!this.config) return { entries: output, warnings: [DISABLED] };
    const pending = [];
    let dimensions = null;
    for (let i = 0; i < output.length; i++) {
      const entry = output[i];
      const cached = entry.embedding;
      const hash = hashContent(entry);
      if (cached?.model === this.config.model && cached.hash === hash && validVector(cached.vector) &&
          (dimensions === null || dimensions === cached.vector.length)) {
        dimensions ??= cached.vector.length;
      } else {
        delete entry.embedding;
        pending.push({ index: i, hash, text: content(entry) });
      }
    }
    const warnings = [];
    for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
      const batch = pending.slice(offset, offset + BATCH_SIZE);
      try {
        const vectors = await this.embed(batch.map(item => item.text));
        if (dimensions !== null && vectors[0].length !== dimensions) throw new Error('Embedding dimensions changed.');
        dimensions ??= vectors[0].length;
        batch.forEach((item, index) => {
          output[item.index].embedding = { model: this.config.model, vector: vectors[index], hash: item.hash };
        });
      } catch {
        warnings.push('Some entries could not be embedded; lexical indexing remains available.');
        // Stop after a failed batch so a provider outage does not cause repeated requests.
        break;
      }
    }
    return { entries: output, warnings };
  }

  async retrieve({ query, entries, limit = 40 }) {
    limit = cleanLimit(limit);
    const text = String(query ?? '').trim().slice(0, 4000);
    const all = lexicalRanking(text, entries);
    const lexical = stableSort(all.filter(candidate => candidate.lexicalScore > 0), 'lexicalScore');
    const fallback = warnings => ({ candidates: publicCandidates(lexical, limit), mode: 'lexical', warnings });
    if (!text || !entries.length || !limit) return fallback([]);
    if (!this.config) return fallback([DISABLED]);
    const indexed = all.filter(({ entry }) => entry.embedding?.model === this.config.model && entry.embedding.hash === hashContent(entry));
    if (!indexed.length) return fallback(['No current embeddings are available; using lexical search.']);
    if (indexed.some(({ entry }) => !validVector(entry.embedding.vector))) return fallback([UNAVAILABLE]);
    let vector;
    try {
      [vector] = await this.embed([text]);
      if (indexed.some(({ entry }) => entry.embedding.vector.length !== vector.length)) throw new Error('Invalid dimensions.');
    } catch { return fallback([UNAVAILABLE]); }
    for (const candidate of indexed) candidate.semanticScore = cosine(vector, candidate.entry.embedding.vector);
    const depth = Math.max(80, limit * 2);
    const semantic = stableSort(indexed.filter(candidate => candidate.semanticScore > 0), 'semanticScore').slice(0, depth);
    const fused = new Map();
    for (const ranking of [lexical.slice(0, depth), semantic]) {
      ranking.forEach((candidate, rank) => {
        const existing = fused.get(candidate.index);
        if (existing) existing.retrievalScore += 1 / (RRF_K + rank + 1);
        else fused.set(candidate.index, { ...candidate, retrievalScore: 1 / (RRF_K + rank + 1) });
      });
    }
    const warnings = indexed.length < entries.length ? ['Some entries lack current embeddings; their ranking uses lexical matches only.'] : [];
    return { candidates: publicCandidates(stableSort([...fused.values()], 'retrievalScore'), limit), mode: 'hybrid', warnings };
  }
}
