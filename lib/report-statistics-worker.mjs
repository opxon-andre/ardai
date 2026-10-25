import { parentPort, workerData } from 'node:worker_threads';
import { projectUsage, capacity } from './usage.mjs';
import { readQualitySummary } from './quality.mjs';

// Keep the usage parser cache warm between refreshes. No state/report writes.
parentPort.on('message', () => {
  try {
    const totals = projectUsage(workerData.logDir, workerData.agents);
    parentPort.postMessage({ data: { usage: totals.tasks, agentUsage: totals.agents,
      capacity: capacity(workerData.logDir, workerData.codexSessions, workerData.agents),
      quality: readQualitySummary(workerData.qualityFile), loading: false } });
  } catch { parentPort.postMessage({ error: true }); }
});
