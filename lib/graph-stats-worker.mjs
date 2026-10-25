import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

// Read the index directly: GraphStore/status may run schema migrations on open.
export function readGraphStats(source) {
  if (!fs.existsSync(source.file)) return { name: source.name, status: 'missing' };
  let db;
  try {
    db = new DatabaseSync(source.file, { readOnly: true, timeout: 200 });
    db.exec('PRAGMA query_only = ON; BEGIN');
    const kinds = Object.fromEntries(db.prepare('SELECT kind, count(*) AS n FROM nodes GROUP BY kind').all().map((r) => [r.kind, r.n]));
    const edges = db.prepare('SELECT count(*) AS n FROM edges').get().n;
    const metadata = Object.fromEntries(db.prepare("SELECT key, value FROM metadata WHERE key IN ('last_updated', 'build_state', 'git_branch')").all().map((r) => [r.key, r.value]));
    const languages = db.prepare("SELECT DISTINCT language FROM nodes WHERE kind = 'File' AND language IS NOT NULL AND language != '' ORDER BY language").all().map((r) => r.language);
    return { name: source.name, status: 'ready', files: kinds.File || 0,
      nodes: Object.values(kinds).reduce((sum, n) => sum + n, 0), edges,
      functions: kinds.Function || 0, classes: kinds.Class || 0, languages,
      updatedAt: metadata.last_updated || null, branch: metadata.git_branch || null,
      incomplete: ['in-progress', 'postprocess-pending'].includes(metadata.build_state) };
  } catch (error) {
    const reason = /no such (table|column)/i.test(error.message) ? 'schema'
      : /malformed|not a database/i.test(error.message) ? 'corrupt'
      : /unable to open|denied|permission|readonly/i.test(error.message) ? 'access' : 'database-error';
    return { name: source.name, status: /locked|busy/i.test(error.message) ? 'busy' : 'unavailable', reason };
  } finally { db?.close(); }
}

if (parentPort) {
  const graphs = workerData.sources.map(readGraphStats);
  Atomics.store(new Int32Array(workerData.completed), 0, 1);
  parentPort.postMessage(graphs);
}
