import { createServer } from 'node:http';
import { AppError } from './errors.mjs';

const PRINCIPAL = 'local';
const BODY_LIMIT = 2 * 1024 * 1024;
async function bodyJson(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new AppError('Content-Type application/json gerekli.', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new AppError('İstek boyutu en fazla 2 MiB olabilir.', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('Geçersiz JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('JSON nesnesi gerekli.');
  if ('userId' in body || 'token' in body || 'apiKey' in body) throw new AppError('Kullanıcı ve API anahtarları HTTP isteğinden alınmaz.');
  return body;
}
function send(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(JSON.stringify(data, null, 2));
}
export function makeServer({ orchestrator }) {
  return createServer({ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (req, res) => {
    try {
      // Local-only API. Reject browser origins and non-loopback Host headers (DNS rebinding).
      const host = String(req.headers.host ?? '');
      if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host) || req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') {
        throw new AppError('Bu API yalnızca yerel istemcilere açık.', 403, 'local_only');
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/api/health') return send(res, 200, { status: 'ok', service: 'bookmarkfinder', version: '0.1.0' });
      if (req.method === 'GET' && path === '/') return send(res, 200, {
        service: 'Bookmark Finder', description: 'Orchestrator + ingestion/search/Jev workers; yerel backend MVP.',
        endpoints: ['GET /api/status', 'POST /api/search', 'POST /api/sync', 'POST /api/index', 'GET /api/jobs/:id', 'POST /api/import', 'DELETE /api/entries'],
        requestHeader: 'X-Recall-Client: local', docs: 'README.md',
      });
      // Every data endpoint needs a custom header; ordinary sites cannot read local private data.
      if (req.headers['x-recall-client'] !== 'local') throw new AppError('X-Recall-Client: local başlığı gerekli.', 403, 'client_header_required');
      if (req.method === 'GET' && path === '/api/status') return send(res, 200, orchestrator.status(PRINCIPAL));
      if (req.method === 'GET' && /^\/api\/jobs\/[a-f0-9-]{36}$/.test(path)) return send(res, 200, orchestrator.getJob(PRINCIPAL, path.split('/').at(-1)));
      if (req.method === 'POST' && path === '/api/search') return send(res, 200, await orchestrator.search(PRINCIPAL, await bodyJson(req)));
      if (req.method === 'POST' && path === '/api/sync') { const body = await bodyJson(req); return send(res, 202, orchestrator.enqueueSync(PRINCIPAL, body.source)); }
      if (req.method === 'POST' && path === '/api/index') { await bodyJson(req); return send(res, 202, orchestrator.enqueueIndex(PRINCIPAL)); }
      if (req.method === 'POST' && path === '/api/import') { const body = await bodyJson(req); return send(res, 200, await orchestrator.importEntries(PRINCIPAL, body.entries)); }
      if (req.method === 'DELETE' && path === '/api/entries') { const source = url.searchParams.get('source') || undefined; return send(res, 200, await orchestrator.clear(PRINCIPAL, source)); }
      throw new AppError('Endpoint bulunamadı.', 404, 'not_found');
    } catch (error) {
      if (!res.headersSent) send(res, error instanceof AppError ? error.status : 500,
        { error: { code: error instanceof AppError ? error.code : 'internal_error', message: error instanceof AppError ? error.message : 'İşlem tamamlanamadı; sağlayıcı bağlantısını ve yapılandırmayı kontrol et.' } });
      else res.end();
    }
  });
}
