import { resolve } from 'node:path';
import { AppError } from './errors.mjs';

export function loadConfig(env = process.env, { demo = false } = {}) {
  const port = Number(env.RECALL_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new AppError('RECALL_PORT 1024–65535 aralığında olmalı.');
  const embeddingFields = [env.EMBEDDING_BASE_URL, env.EMBEDDING_MODEL];
  if (!demo && embeddingFields.some(Boolean) && !embeddingFields.every(Boolean)) throw new AppError('Embedding için BASE_URL ve MODEL birlikte gerekli.');
  return {
    port, dbPath: resolve(demo ? './data/demo.sqlite' : (env.RECALL_DB || './data/recall.sqlite')),
    demo,
    githubToken: demo ? '' : (env.GITHUB_TOKEN || ''),
    xToken: demo ? '' : (env.X_ACCESS_TOKEN || ''),
    xUserId: demo ? '' : (env.X_USER_ID || ''),
    jevConfig: { apiKey: demo ? '' : (env.JEV_API_KEY || ''), model: env.JEV_MODEL || 'jev-latest' },
    embeddingConfig: !demo && embeddingFields.every(Boolean)
      ? { baseUrl: env.EMBEDDING_BASE_URL, model: env.EMBEDDING_MODEL, apiKey: env.EMBEDDING_API_KEY || '' } : null,
  };
}
