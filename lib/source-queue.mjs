// Bounded parallelism between tickets; strict FIFO within each ticket, including
// a delayed retry at the head. The owner alone mutates/persists the shared state.
export class SourceActionQueue {
  constructor({ actions, execute, concurrency, canRun = () => true, onError = () => {}, onSettled = () => {} }) {
    Object.assign(this, { actions, execute, concurrency, canRun, onError, onSettled });
    this.jobs = new Map();
  }

  get size() { return this.jobs.size; }

  pump() {
    const started = [];
    if (!this.canRun()) return started;
    const seen = new Set([...this.jobs.values()].map((job) => job.taskId));
    for (const action of this.actions()) {
      if (this.size >= this.concurrency()) break;
      if (seen.has(action.taskId)) continue;
      seen.add(action.taskId);
      if (action.retryAt && new Date(action.retryAt).getTime() > Date.now()) continue;
      const job = { taskId: action.taskId, promise: null };
      this.jobs.set(action.id, job);
      // Launch before returning to the runner's synchronous Git work, while
      // reserving the lane first to prevent re-entrant duplicate dispatch.
      let result;
      try { result = this.execute(action); } catch (error) { result = Promise.reject(error); }
      const promise = Promise.resolve(result)
        .catch((error) => { this.onError(error); return false; })
        .finally(() => { this.jobs.delete(action.id); this.pump(); this.onSettled(); });
      job.promise = promise;
      started.push(promise);
    }
    return started;
  }
}
