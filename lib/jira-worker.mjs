import { parentPort, workerData } from 'node:worker_threads';
import { JiraClient, applyAction } from './jira.mjs';
import { createPolisher } from './ollama.mjs';
import { makeT } from './i18n.mjs';

const client = new JiraClient(workerData.auth);
const polish = createPolisher(workerData.ollama);
const t = makeT(workerData.language, workerData.brand);
const acknowledgements = new Map();
parentPort.on('message', async (message) => {
  if (message.type === 'ack') {
    const pending = acknowledgements.get(message.key);
    if (pending) {
      acknowledgements.delete(message.key);
      message.error ? pending.reject(new Error(message.error)) : pending.resolve();
    }
    return;
  }
  if (message.type !== 'action') return;
  try {
    await applyAction(client, message.action, {
      src: workerData.src, t, polish,
      onProgress: (step) => new Promise((resolve, reject) => {
        const key = `${message.id}:${step}`;
        acknowledgements.set(key, { resolve, reject });
        parentPort.postMessage({ type: 'progress', id: message.id, step, key });
      }),
    });
    parentPort.postMessage({ type: 'result', id: message.id, ok: true });
  } catch (error) {
    parentPort.postMessage({ type: 'result', id: message.id, ok: false, error: {
      message: error.message, status: error.status, retryable: error.retryable, retryAfterMs: error.retryAfterMs,
    } });
  }
});
