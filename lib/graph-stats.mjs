import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export function readGraphs(sources) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./graph-stats-worker.mjs', import.meta.url), {
      workerData: sources, execArgv: ['--no-warnings'],
    });
    let settled = false;
    const finish = (graphs) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(graphs);
    };
    const unavailable = () => sources.map(({ name }) => ({ name, status: 'unavailable' }));
    const timer = setTimeout(() => { finish(unavailable()); void worker.terminate(); }, 10000);
    worker.once('message', finish);
    worker.once('error', () => finish(unavailable()));
    worker.once('exit', () => finish(unavailable()));
  }).catch(() => sources.map(({ name }) => ({ name, status: 'unavailable' })));
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
