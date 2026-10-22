import { Worker } from 'node:worker_threads';

// HTTP and response-body deadlines run independently of synchronous Git/report
// work in the orchestrator. No worker ever writes state.json.
export class JiraExecutor {
  constructor(options) { this.options = options; this.pending = new Map(); this.sequence = 0; }

  start() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./jira-worker.mjs', import.meta.url), { workerData: this.options });
    this.worker = worker;
    worker.unref();
    worker.on('message', async (message) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.type === 'progress') {
        try {
          await pending.onProgress?.(message.step);
          worker.postMessage({ type: 'ack', key: message.key });
        } catch (error) { worker.postMessage({ type: 'ack', key: message.key, error: error.message }); }
        return;
      }
      if (message.type !== 'result') return;
      this.pending.delete(message.id);
      if (!this.pending.size) worker.unref();
      if (message.ok) pending.resolve();
      else pending.reject(Object.assign(new Error(message.error.message), message.error));
    });
    const fail = (error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`Jira worker exited (${code})`)));
    return worker;
  }

  apply(action, onProgress) {
    const worker = this.start(), id = ++this.sequence;
    worker.ref();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ type: 'action', id, action });
    });
  }

  async close() {
    if (this.worker) await this.worker.terminate();
  }
}
