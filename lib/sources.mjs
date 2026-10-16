import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_BRAND, stoppedLabels } from './brand.mjs';
import { AgentRun } from './agents.mjs';

// Ticket updates in the task source (stop / clean / resume). ardai itself has
// no ticket-system credentials; a short agent call (small model) performs the
// update through the agent's own MCP access. Actions are queued in the state
// and retried until an agent is available, so they also survive token outages.
//
// Supported source types: "jira". GitHub Issues is planned (via gh CLI).

export const SOURCE_ACTIONS = ['stopped', 'cleaned', 'resumed'];

function jiraInstructions(action, src, t) {
  const key = action.taskId;
  const label = src.stoppedLabel || DEFAULT_BRAND.stoppedLabel;
  const labels = [...new Set([label, ...(src.stoppedLabels || stoppedLabels())])];
  const comment = t(`jira.comment.${action.type}`, { task: key, branch: action.branch });
  const labelRule = 'IMPORTANT: when editing labels, the labels field is REPLACED as a whole – read the current labels first and send the complete new list.';
  const steps = {
    stopped: [`Add this comment: "${comment}"`, `Add the label "${label}" (keep all existing labels). ${labelRule}`],
    cleaned: [`Add this comment: "${comment}"`, `Transition the issue to the status "${src.todoStatus || 'To Do'}".`, `Remove all of these labels if present: ${labels.map((value) => JSON.stringify(value)).join(', ')} (keep all other labels). ${labelRule}`],
    resumed: [`Add this comment: "${comment}"`, `Remove all of these labels if present: ${labels.map((value) => JSON.stringify(value)).join(', ')} (keep all other labels). ${labelRule}`],
  }[action.type];
  return `Use your Atlassian/Jira MCP tools${src.cloudId ? ` (cloudId ${src.cloudId})` : ''} to update the Jira issue ${key}:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\nDo nothing else: no code changes, no other issues.`;
}

export function sourceActionPrompt(action, src, t, outFile) {
  if ((src.type || 'jira') !== 'jira') throw new Error(`Source type "${src.type}" is not supported yet`);
  return `${jiraInstructions(action, src, t)}

When finished, write a JSON file to:
${outFile}
with {"ok": true} on success, or {"ok": false, "error": "<short reason>"} if a step failed.`;
}

export async function runSourceAction(action, { src, t, agent, agentCfg, runtimeDir }) {
  const dir = path.join(runtimeDir, 'source-actions');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${action.taskId}-${action.type}-${Date.now()}.json`);
  const run = new AgentRun({
    name: agent,
    agentCfg,
    cwd: runtimeDir,
    prompt: sourceActionPrompt(action, src, t, out),
    logFile: path.join(runtimeDir, 'logs', `source-${agent}-${Date.now()}.jsonl`),
    maxRunMinutes: 10,
    extraArgs: agentCfg.bySize?.S?.args || [], // small, cheap model is enough
  });
  const outcome = await run.start();
  let result = null;
  try { result = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* no result file */ }
  if (result?.ok) return { ok: true };
  return { ok: false, outage: outcome.outage, resetsAt: outcome.resetsAt, error: result?.error || outcome.error?.slice(0, 200) || 'no result file' };
}

// Windows: end an agent and everything it started (shells, tests, docker CLI).
export function killTree(pid) {
  if (!pid) return false;
  const res = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  return res.status === 0;
}

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
