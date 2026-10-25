import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export function readGraphs(sources, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const completed = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(new URL('./graph-stats-worker.mjs', import.meta.url), {
      workerData: { sources, completed: completed.buffer }, execArgv: ['--no-warnings'],
    });
    let settled = false;
    const finish = (graphs) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(graphs);
    };
    const unavailable = (reason) => sources.map(({ name }) => ({ name, status: 'unavailable', reason }));
    const timer = setTimeout(() => {
      // Message delivery can be delayed by synchronous Git in the main thread.
      // A completed worker must never be mistaken for a slow database query.
      if (Atomics.load(completed, 0)) return;
      finish(unavailable('timeout')); void worker.terminate();
    }, timeoutMs);
    worker.once('message', finish);
    worker.once('error', () => finish(unavailable('worker-error')));
    worker.once('exit', () => finish(unavailable('worker-error')));
  }).catch(() => sources.map(({ name }) => ({ name, status: 'unavailable', reason: 'worker-error' })));
}

// Snapshot stays synchronous for the report. SQLite scans run off the main loop,
// once initially and after invalidation by a successful ticket merge. Reads never
// overlap or create/migrate an index.
export class GraphStatistics {
  constructor({ repoRoot, worktreeRoot, agents, enabled, onUpdate = () => {} }) {
    Object.assign(this, { repoRoot, worktreeRoot, agents, enabled, onUpdate });
    this.data = { enabled, graphs: [], loading: false };
    this.dirty = true;
  }

  invalidate() { this.dirty = true; }

  snapshot() {
    if (!this.pending && this.dirty) {
      this.dirty = false;
      const sources = [{ name: 'Projekt', dir: this.repoRoot },
        ...Object.entries(this.agents).map(([name, cfg]) => ({ name, dir: path.join(this.worktreeRoot, name), enabled: cfg.enabled }))]
        .map((s) => ({ ...s, file: path.join(s.dir, '.code-review-graph', 'graph.db') }))
        .filter((s) => fs.existsSync(s.file) || (this.enabled && s.enabled));
      if (sources.length) {
        this.data = { ...this.data, loading: true };
        this.pending = readGraphs(sources).then((graphs) => {
          this.data = { enabled: this.enabled, graphs, loading: false, checkedAt: Date.now() };
        }).finally(() => {
          this.pending = null;
          // A merge during the read must not be lost; coalesce such events into
          // one follow-up read after the current worker finishes.
          if (this.dirty) this.snapshot();
          this.onUpdate();
        });
      }
    }
    return this.data;
  }
}
