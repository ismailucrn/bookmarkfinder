import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError, requireUser, requireSource } from './errors.mjs';

const MAX_ENTRIES = 10000;
function iso(value, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new AppError('Geçersiz tarih.');
  return new Date(value).toISOString();
}
export function normalizeEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('Kayıt nesne olmalı.');
  const source = requireSource(input.source);
  const externalId = String(input.externalId ?? '');
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(externalId) || input.id !== `${source}:${externalId}`) throw new AppError('Kayıt kimliği source:externalId biçiminde olmalı.');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 1000) throw new AppError('Geçersiz başlık.');
  if (typeof input.text !== 'string' || input.text.length > 100000) throw new AppError('İçerik en fazla 100.000 karakter olabilir.');
  let url;
  try { url = new URL(input.url); } catch { throw new AppError('Geçersiz kaynak bağlantısı.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4000) throw new AppError('Geçersiz kaynak bağlantısı.');
  const metadata = input.metadata ?? {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || JSON.stringify(metadata).length > 16000) throw new AppError('Geçersiz metadata.');
  const entry = {
    id: input.id, source, externalId, url: url.href, title: input.title.trim(), text: input.text,
    metadata: structuredClone(metadata), savedAt: iso(input.savedAt, true),
    updatedAt: iso(input.updatedAt ?? new Date().toISOString()),
  };
  if (input.embedding !== undefined) {
    const { model, hash, vector } = input.embedding ?? {};
    if (typeof model !== 'string' || !model || model.length > 200 || typeof hash !== 'string' || hash.length !== 64 ||
      !Array.isArray(vector) || !vector.length || vector.length > 32768 || !vector.every(n => typeof n === 'number' && Number.isFinite(n))) {
      throw new AppError('Geçersiz embedding.');
    }
    entry.embedding = { model, hash, vector: [...vector] };
  }
  return entry;
}

export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS entries (
        user_id TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (user_id, id)
      );
      CREATE INDEX IF NOT EXISTS entries_user_source ON entries(user_id, source);
      CREATE TABLE IF NOT EXISTS jobs (
        user_id TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (user_id, id)
      );
    `);
  }
  list(userId, source) {
    requireUser(userId); if (source !== undefined) requireSource(source);
    const rows = source
      ? this.db.prepare('SELECT payload FROM entries WHERE user_id=? AND source=? ORDER BY id').all(userId, source)
      : this.db.prepare('SELECT payload FROM entries WHERE user_id=? ORDER BY id').all(userId);
    return rows.map(row => JSON.parse(row.payload));
  }
  writeEntries(userId, entries, { replaceSource } = {}) {
    requireUser(userId);
    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw new AppError('En fazla 10.000 kayıt aktarılabilir.');
    if (replaceSource !== undefined) requireSource(replaceSource);
    const normalized = entries.map(normalizeEntry);
    if (replaceSource && normalized.some(e => e.source !== replaceSource)) throw new AppError('Kaynak eşleşmiyor.');
    if (new Set(normalized.map(e => e.id)).size !== normalized.length) throw new AppError('Tekrarlanan kayıt kimliği.');
    const oldEntries = this.list(userId);
    const existing = new Map(oldEntries.map(e => [e.id, e]));
    const incomingIds = new Set(normalized.map(e => e.id));
    const retainedCount = oldEntries.filter(e => e.source !== replaceSource && !incomingIds.has(e.id)).length;
    if (retainedCount + normalized.length > MAX_ENTRIES) throw new AppError('Kullanıcı kayıt sınırı 10.000.');
    // Reuse unchanged content embeddings across provider refreshes.
    for (const entry of normalized) {
      const old = existing.get(entry.id);
      if (!entry.embedding && old?.embedding && old.title === entry.title && old.text === entry.text) entry.embedding = old.embedding;
    }
    const put = this.db.prepare('INSERT INTO entries(user_id,id,source,payload) VALUES(?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET source=excluded.source,payload=excluded.payload');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (replaceSource) this.db.prepare('DELETE FROM entries WHERE user_id=? AND source=?').run(userId, replaceSource);
      for (const entry of normalized) put.run(userId, entry.id, entry.source, JSON.stringify(entry));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return normalized.length;
  }
  // Exact replacement used by reindex to remove stale/failed vectors.
  replaceAll(userId, entries) {
    requireUser(userId);
    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw new AppError('Geçersiz kayıt sayısı.');
    const normalized = entries.map(normalizeEntry);
    if (new Set(normalized.map(e => e.id)).size !== normalized.length) throw new AppError('Tekrarlanan kayıt kimliği.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM entries WHERE user_id=?').run(userId);
      const put = this.db.prepare('INSERT INTO entries(user_id,id,source,payload) VALUES(?,?,?,?)');
      for (const e of normalized) put.run(userId, e.id, e.source, JSON.stringify(e));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return normalized.length;
  }
  clear(userId, source) {
    requireUser(userId); if (source) requireSource(source);
    return source ? this.db.prepare('DELETE FROM entries WHERE user_id=? AND source=?').run(userId, source).changes
      : this.db.prepare('DELETE FROM entries WHERE user_id=?').run(userId).changes;
  }
  counts(userId) {
    requireUser(userId);
    const counts = { github: 0, x: 0, manual: 0, total: 0 };
    for (const row of this.db.prepare('SELECT source,COUNT(*) AS n FROM entries WHERE user_id=? GROUP BY source').all(userId)) {
      counts[row.source] = row.n; counts.total += row.n;
    }
    return counts;
  }
  saveJob(userId, job) {
    requireUser(userId);
    this.db.prepare('INSERT INTO jobs(user_id,id,state,payload) VALUES(?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET state=excluded.state,payload=excluded.payload')
      .run(userId, job.id, job.state, JSON.stringify(job));
  }
  getJob(userId, id) {
    requireUser(userId);
    const row = this.db.prepare('SELECT payload FROM jobs WHERE user_id=? AND id=?').get(userId, id);
    return row ? JSON.parse(row.payload) : null;
  }
  recentJobs(userId, limit = 20) {
    requireUser(userId);
    return this.db.prepare('SELECT payload FROM jobs WHERE user_id=? ORDER BY rowid DESC LIMIT ?').all(userId, limit).map(row => JSON.parse(row.payload));
  }
  recoverJobs() {
    const rows = this.db.prepare("SELECT user_id,payload FROM jobs WHERE state IN ('queued','running')").all();
    for (const row of rows) {
      const job = JSON.parse(row.payload);
      this.saveJob(row.user_id, { ...job, state: 'failed', finishedAt: new Date().toISOString(), error: 'İşlem uygulama kapanınca kesildi; yeniden başlatılabilir.' });
    }
  }
  close() { this.db.close(); }
}
