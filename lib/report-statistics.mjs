import { Worker } from 'node:worker_threads';

export class ReportStatistics {
  constructor(options, onUpdate = () => {}) {
    this.options = options;
    this.onUpdate = onUpdate;
    this.nextRead = 0;
    this.data = { usage: {}, agentUsage: {}, capacity: {}, quality: options.qualityFile ? { loading: true } : null, loading: true };
  }

  start() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./report-statistics-worker.mjs', import.meta.url), { workerData: this.options });
    this.worker = worker;
    worker.on('message', (message) => {
      if (this.worker === worker) this.finish(message.data || { ...this.data, loading: false, error: true });
    });
    const fail = () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.finish({ ...this.data, loading: false, error: true });
    };
    worker.once('error', fail);
    worker.once('exit', fail);
    worker.unref();
    return worker;
  }

  finish(data) {
    if (!this.pending) return;
    this.data = data;
    this.nextRead = Date.now() + 4000;
    const resolve = this.resolve;
    this.pending = this.resolve = null;
    this.worker?.unref();
    resolve(data);
    this.onUpdate();
  }

  snapshot() {
    if (!this.pending && Date.now() >= this.nextRead) {
      try {
        const worker = this.start();
        this.pending = new Promise((resolve) => { this.resolve = resolve; });
        worker.ref();
        worker.postMessage('read');
      } catch {
        if (this.pending) this.finish({ ...this.data, loading: false, error: true });
        else { this.nextRead = Date.now() + 4000; this.data = { ...this.data, loading: false, error: true }; }
      }
    }
    return this.data;
  }

  async fresh() {
    await this.pending;
    this.nextRead = 0;
    this.snapshot();
    await this.pending;
    return this.data;
  }

  async close() {
    if (this.worker) await this.worker.terminate();
  }
}
