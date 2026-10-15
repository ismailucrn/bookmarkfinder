import { readFile } from 'node:fs/promises';
import { Store } from './store.mjs';
import { loadConfig } from './config.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { makeServer } from './server.mjs';
import { AppError } from './errors.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
let store;
async function demoEntries() {
  return JSON.parse(await readFile(new URL('../fixtures/demo.json', import.meta.url), 'utf8'));
}
async function main() {
  if (command === 'help') {
    console.log('Bookmark Finder: demo | serve [--demo] | search "sorgu" [--demo] | sync github|x | index | status | import dosya.json');
    return;
  }
  const demo = command === 'demo' || args.includes('--demo');
  const config = loadConfig(process.env, { demo });
  store = new Store(command === 'demo' ? ':memory:' : config.dbPath);
  const orchestrator = new Orchestrator({ store, config });
  if (demo) await orchestrator.importEntries('local', await demoEntries());
  if (command === 'serve') {
    const server = makeServer({ orchestrator });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
    console.log(`Bookmark Finder ${demo ? 'DEMO (örnek veriler, harici API kapalı)' : 'yerel backend'}: http://127.0.0.1:${config.port}`);
    console.log('İsteklerde X-Recall-Client: local başlığını kullan. Kapat: Ctrl+C.');
    const stop = async () => { server.close(); await orchestrator.drain(); store.close(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return;
  }
  let result;
  if (command === 'demo') result = await orchestrator.search('local', { query: args.join(' ') || 'PDF tablo çıkarma Python' });
  else if (command === 'search') result = await orchestrator.search('local', { query: args.filter(arg => arg !== '--demo').join(' ') });
  else if (command === 'status') result = orchestrator.status('local');
  else if (command === 'sync' || command === 'index') {
    const job = command === 'sync' ? orchestrator.enqueueSync('local', args[0]) : orchestrator.enqueueIndex('local');
    console.log(JSON.stringify({ jobId: job.id, state: job.state }));
    await orchestrator.drain(); result = orchestrator.getJob('local', job.id);
    if (result.state === 'failed') process.exitCode = 1;
  } else if (command === 'import') {
    if (!args[0]) throw new AppError('JSON dosya yolu gerekli.');
    const content = await readFile(args[0], 'utf8');
    if (content.length > 2 * 1024 * 1024) throw new AppError('Aktarım dosyası en fazla 2 MiB olabilir.');
    result = await orchestrator.importEntries('local', JSON.parse(content));
  } else throw new AppError('Bilinmeyen komut. node src/cli.mjs help');
  console.log(JSON.stringify(result, null, 2)); store.close();
}
main().catch(error => {
  console.error(error instanceof AppError ? error.message : 'İşlem tamamlanamadı. Yapılandırmayı, dosyayı ve sağlayıcı erişimini kontrol et.');
  try { store?.close(); } catch {}
  process.exitCode = 1;
});
