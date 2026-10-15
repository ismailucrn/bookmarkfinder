import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AppError, requireUser, requireSource } from './errors.mjs';
import { SearchWorker } from './workers/search.mjs';
import { JevWorker } from './workers/jev.mjs';
import { fetchGithubStars, fetchXBookmarks } from './workers/connectors.mjs';

export class Orchestrator {
  constructor({ store, config, searchWorker, jevWorker, connectors } = {}) {
    this.store = store; this.config = config;
    this.searchWorker = searchWorker ?? new SearchWorker({ embeddingConfig: config.embeddingConfig });
    this.jevWorker = jevWorker ?? new JevWorker(config.jevConfig);
    this.connectors = connectors ?? { github: fetchGithubStars, x: fetchXBookmarks };
    this.locks = new Map(); this.activeJobs = new Map(); this.pending = new Set(); this.searches = 0;
    this.store.recoverJobs();
  }
  status(userId) {
    requireUser(userId);
    return {
      demo: this.config.demo === true,
      counts: this.store.counts(userId),
      workers: {
        ingestion: { githubConfigured: Boolean(this.config.githubToken), xConfigured: Boolean(this.config.xToken && this.config.xUserId) },
        search: { semanticConfigured: Boolean(this.config.embeddingConfig), lexical: 'BM25' },
        ranking: { jevConfigured: Boolean(this.config.jevConfig?.apiKey), model: this.config.jevConfig?.model || 'jev-latest' },
      },
      jobs: this.store.recentJobs(userId),
    };
  }
  async withUserLock(userId, operation) {
    requireUser(userId);
    const previous = this.locks.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.locks.set(userId, current);
    try { return await current; } finally { if (this.locks.get(userId) === current) this.locks.delete(userId); }
  }
  async stage(trace, worker, operation) {
    const item = { worker, state: 'running', durationMs: 0 };
    trace.push(item); const started = performance.now();
    try {
      const result = await operation();
      item.state = 'succeeded';
      if (result?.mode) item.mode = result.mode;
      if (Array.isArray(result?.entries)) item.count = result.entries.length;
      if (Array.isArray(result?.candidates)) item.count = result.candidates.length;
      if (Array.isArray(result?.results)) item.count = result.results.length;
      return result;
    } catch (error) { item.state = 'failed'; throw error; }
    finally { item.durationMs = Math.round(performance.now() - started); }
  }
  schedule(userId, kind, operation) {
    requireUser(userId);
    const key = `${userId}:${kind}`;
    if (this.activeJobs.has(key)) return this.store.getJob(userId, this.activeJobs.get(key));
    if (this.pending.size >= 32) throw new AppError('İş kuyruğu dolu; tekrar dene.', 429, 'queue_full');
    const job = { id: randomUUID(), kind, state: 'queued', createdAt: new Date().toISOString(), trace: [] };
    this.store.saveJob(userId, job); this.activeJobs.set(key, job.id);
    const promise = this.withUserLock(userId, async () => {
      job.state = 'running'; job.startedAt = new Date().toISOString(); this.store.saveJob(userId, job);
      try {
        job.result = await operation(job.trace);
        job.state = 'succeeded';
      } catch {
        job.state = 'failed'; job.error = 'İşlem tamamlanamadı. Bağlantı izinlerini, yapılandırmayı ve sağlayıcı erişimini kontrol et; önceki kayıtlar korunur.';
      } finally {
        job.finishedAt = new Date().toISOString(); this.store.saveJob(userId, job);
        this.activeJobs.delete(key);
      }
    });
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return structuredClone(job);
  }
  async drain() { await Promise.allSettled([...this.pending]); }
  async importEntries(userId, entries) {
    return this.withUserLock(userId, async () => {
      const count = this.store.writeEntries(userId, entries);
      return { imported: count, counts: this.store.counts(userId) };
    });
  }
  async clear(userId, source) {
    return this.withUserLock(userId, () => ({ deleted: this.store.clear(userId, source) }));
  }
  enqueueSync(userId, source) {
    requireUser(userId); requireSource(source);
    if (!['github', 'x'].includes(source)) throw new AppError('Senkronizasyon kaynağı github veya x olmalı.');
    if (source === 'github' && !this.config.githubToken) throw new AppError('GITHUB_TOKEN yapılandırılmamış.', 409, 'provider_not_configured');
    if (source === 'x' && !(this.config.xToken && this.config.xUserId)) throw new AppError('X_ACCESS_TOKEN ve X_USER_ID yapılandırılmamış.', 409, 'provider_not_configured');
    return this.schedule(userId, `sync:${source}`, async trace => {
      const fetched = await this.stage(trace, 'ingestion', () => this.connectors[source](source === 'github'
        ? { token: this.config.githubToken } : { token: this.config.xToken, userId: this.config.xUserId }));
      if (!fetched || !Array.isArray(fetched.entries) || typeof fetched.complete !== 'boolean') throw new Error('Invalid connector contract');
      // Carry cached vectors into reindexing; no mutation of stored snapshots until network work succeeds.
      const old = new Map(this.store.list(userId).map(entry => [entry.id, entry]));
      const refreshed = fetched.entries.map(entry => {
        const previous = old.get(entry.id);
        return previous?.embedding && previous.text === entry.text && previous.title === entry.title
          ? { ...entry, embedding: previous.embedding } : entry;
      });
      const indexed = await this.stage(trace, 'index', () => this.searchWorker.indexEntries(refreshed));
      const warnings = [...(fetched.warnings ?? []), ...(indexed.warnings ?? [])];
      await this.stage(trace, 'storage', async () => {
        this.store.writeEntries(userId, indexed.entries, fetched.complete ? { replaceSource: source } : {});
        return { entries: indexed.entries };
      });
      if (!fetched.complete) warnings.push('Aktarım eksik; önceki kayıtlardan hiçbiri silinmedi.');
      return { imported: indexed.entries.length, complete: fetched.complete, warnings: [...new Set(warnings)], counts: this.store.counts(userId) };
    });
  }
  enqueueIndex(userId) {
    return this.schedule(userId, 'index', async trace => {
      const indexed = await this.stage(trace, 'index', () => this.searchWorker.indexEntries(this.store.list(userId)));
      await this.stage(trace, 'storage', async () => { this.store.replaceAll(userId, indexed.entries); return indexed; });
      return { indexed: indexed.entries.filter(entry => entry.embedding).length, total: indexed.entries.length, warnings: indexed.warnings };
    });
  }
  getJob(userId, id) {
    const job = this.store.getJob(userId, id);
    if (!job) throw new AppError('İş bulunamadı.', 404, 'not_found');
    return job;
  }
  async search(userId, options = {}) {
    if (this.searches >= 2) throw new AppError('Arama kapasitesi dolu; tekrar dene.', 429, 'search_busy');
    this.searches++;
    try { return await this.performSearch(userId, options); } finally { this.searches--; }
  }
  async performSearch(userId, { query, source, limit = 10 } = {}) {
    requireUser(userId);
    if (typeof query !== 'string' || !query.trim() || query.length > 4000) throw new AppError('Sorgu 1–4.000 karakter olmalı.');
    if (source !== undefined) requireSource(source);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new AppError('limit 1–20 aralığında olmalı.');
    const trace = [];
    const entries = this.store.list(userId, source);
    const retrieved = await this.stage(trace, 'search', () => this.searchWorker.retrieve({ query, entries, limit: 40 }));
    const ranked = await this.stage(trace, 'jev', () => this.jevWorker.rank({ query, candidates: retrieved.candidates, limit }));
    const warnings = [...new Set([...(retrieved.warnings ?? []), ...(ranked.warnings ?? [])])];
    if (!ranked.results.length) warnings.push('Eşleşme bulunamadı. Kelimeleri değiştir veya anlamsal aramayı etkinleştir.');
    return {
      query, corpusSize: entries.length, candidateCount: retrieved.candidates.length,
      mode: { retrieval: retrieved.mode, ranking: ranked.mode }, warnings, trace,
      results: ranked.results.map((candidate, index) => ({
        rank: index + 1, id: candidate.entry.id, source: candidate.entry.source,
        title: candidate.entry.title, url: candidate.entry.url,
        excerpt: candidate.entry.text.slice(0, 600), savedAt: candidate.entry.savedAt,
        retrievalScore: candidate.retrievalScore, lexicalScore: candidate.lexicalScore,
        semanticScore: candidate.semanticScore, relevanceScore: candidate.relevanceScore,
        confidence: candidate.confidence, rankingMethod: candidate.rankingMethod,
      })),
    };
  }
}
