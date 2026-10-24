// Direct Jira Cloud REST access for status, comment and label updates.
// No language model is involved: these are plain HTTPS calls made by ardai itself, so they cost no agent tokens.
// Credentials: Atlassian account e-mail + API token (id.atlassian.com → Security → API tokens).
// The token is read from a git-ignored file or the environment and never handed to agents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class JiraError extends Error {
  constructor(message, { status = 0, retryable = false, retryAfterMs } = {}) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

// "~" and "~/..." point to the home directory; everything else resolves against the repository.
export function resolveTokenFile(file, repoRoot, home = os.homedir()) {
  const value = String(file);
  if (value === '~' || /^~[\\/]/.test(value)) return path.join(home, value.slice(1));
  return path.resolve(repoRoot || '.', value);
}

export function loadJiraAuth({ config, repoRoot, env = process.env } = {}) {
  const src = config?.source || {};
  const baseUrl = String(config?.jiraBaseUrl || '').trim().replace(/\/+$/, '');
  const email = String(env.ARDAI_JIRA_EMAIL || src.jiraEmail || '').trim();
  let token = String(env.ARDAI_JIRA_TOKEN || '').trim();
  if (!token && src.tokenFile) {
    const file = resolveTokenFile(src.tokenFile, repoRoot);
    try { token = fs.readFileSync(file, 'utf8').trim(); } catch { /* not configured */ }
  }
  if (!baseUrl || !email || !token || /\s/.test(token)) return null;
  return { baseUrl, email, token };
}

export class JiraClient {
  constructor({ baseUrl, email, token, fetchImpl = globalThis.fetch, timeoutMs = 45_000 }) {
    Object.assign(this, { baseUrl, fetchImpl, timeoutMs });
    this.authorization = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    this.secret = token;
  }

  async request(method, apiPath, body) {
    if (this.retryNotBefore > Date.now()) throw new JiraError('Jira rate limit: Retry-After active', { status: 429, retryable: true, retryAfterMs: this.retryNotBefore - Date.now() });
    let response, text;
    // Retry a timed-out read once. Repeating an ambiguous POST immediately could
    // duplicate a comment that Jira accepted before the connection was lost.
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
          method,
          headers: { authorization: this.authorization, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        text = await response.text();
        break;
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        if (timedOut && method === 'GET' && attempt < 1) continue;
        throw new JiraError(`Jira nicht erreichbar: ${String(err.message || err).replaceAll(this.secret, '[redacted]')}`, { retryable: true });
      }
    }
    if (!response.ok) {
      const detail = text.replaceAll(this.secret, '[redacted]').slice(0, 300);
      const retryable = response.status === 429 || response.status >= 500;
      const hint = response.status === 401 || response.status === 403 ? ' (E-Mail/API-Token prüfen)' : '';
      const header = response.headers?.get('retry-after');
      const delay = header ? (/^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : NaN;
      const retryAfterMs = Number.isFinite(delay) && delay >= 0 ? delay : undefined;
      if (response.status === 429) this.retryNotBefore = Math.max(this.retryNotBefore || 0, Date.now() + (retryAfterMs ?? 60_000));
      throw new JiraError(`Jira ${method} ${apiPath.split('?')[0]}: HTTP ${response.status}${hint} ${detail}`.trim(), { status: response.status, retryable, retryAfterMs });
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }
}

// Plain text → minimal Atlassian Document Format (paragraphs split by blank lines, line breaks kept).
export function adf(text) {
  const paragraphs = String(text).trim().split(/\n{2,}/).filter(Boolean);
  const content = paragraphs.map((p) => ({
    type: 'paragraph',
    content: p.split('\n').flatMap((line, i, all) => [
      ...(line ? [{ type: 'text', text: line }] : []),
      ...(i < all.length - 1 ? [{ type: 'hardBreak' }] : []),
    ]),
  }));
  return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph', content: [] }] };
}

export const addComment = (client, key, text) =>
  client.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: adf(text) });

// Ein eingeschränkter Jira-Workflow erlaubt nicht jeden Übergang. Deshalb:
//  - soft: fehlt der Übergang, wird er übersprungen (Rückgabe skipped) statt die Aktion scheitern zu lassen
//    (z. B. "In Progress" bei einem Ticket, das schon "In Review" ist, oder "To Do" aus "In Progress").
//  - via: Zwischenstatus, über den ein fehlender Direktübergang genommen wird (z. B. To Do -> In Progress -> In Review).
export async function transitionTo(client, key, statusName, { soft = false, via = null } = {}) {
  const issue = await client.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`);
  const current = issue?.fields?.status?.name;
  if (current && current.toLowerCase() === statusName.toLowerCase()) return { changed: false, status: current };
  const find = (list, name) => (list?.transitions || []).find((tr) => tr.to?.name?.toLowerCase() === name.toLowerCase() || tr.name?.toLowerCase() === name.toLowerCase());
  const path = `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
  let list = await client.request('GET', path);
  let match = find(list, statusName);
  if (!match && via && current?.toLowerCase() !== via.toLowerCase()) {
    const step = find(list, via);
    if (step) {
      await client.request('POST', path, { transition: { id: step.id } });
      list = await client.request('GET', path);
      match = find(list, statusName);
    }
  }
  if (!match) {
    const names = (list?.transitions || []).map((tr) => tr.to?.name || tr.name).join(', ') || '(keine)';
    if (soft) return { changed: false, skipped: true, status: current, reason: `kein Übergang nach "${statusName}" von "${current}" (verfügbar: ${names})` };
    throw new JiraError(`${key}: kein Übergang nach "${statusName}" von "${current}" möglich (verfügbar: ${names}).`);
  }
  await client.request('POST', path, { transition: { id: match.id } });
  return { changed: true, status: statusName };
}

// "update" operations add/remove single labels; other labels stay untouched (no whole-list replacement).
export async function changeLabels(client, key, { add = [], remove = [] } = {}) {
  const update = [...add.map((label) => ({ add: label })), ...remove.map((label) => ({ remove: label }))];
  if (!update.length) return;
  await client.request('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, { update: { labels: update } });
}

export const REST_ACTIONS = new Set(['stopped', 'cleaned', 'resumed', 'started', 'review', 'failed']);

// Executes one queued ticket action through the REST API. Comment texts come from the translation table or the action.
export async function applyAction(client, action, { src = {}, t, polish, onProgress } = {}) {
  const key = action.taskId;
  const stopped = [...new Set([src.stoppedLabel, ...(src.stoppedLabels || [])].filter(Boolean))];
  const comment = action.comment || t(`jira.comment.${action.type}`, { task: key, branch: action.branch });
  const step = async (name, run) => {
    if (action.completedSteps?.includes(name)) return;
    await run();
    await onProgress?.(name);
  };
  switch (action.type) {
    case 'stopped':
      await step('comment', () => addComment(client, key, comment));
      await step('labels', () => changeLabels(client, key, { add: stopped.slice(0, 1) }));
      return;
    case 'cleaned':
      await step('comment', () => addComment(client, key, comment));
      await step('transition', () => transitionTo(client, key, src.todoStatus || 'To Do', { soft: true }));
      await step('labels', () => changeLabels(client, key, { remove: stopped }));
      return;
    case 'resumed':
      await step('comment', () => addComment(client, key, comment));
      await step('labels', () => changeLabels(client, key, { remove: stopped }));
      return;
    case 'started':
      await step('transition', () => transitionTo(client, key, src.inProgressStatus || 'In Progress', { soft: true }));
      return;
    case 'review': {
      await step('comment', async () => addComment(client, key, (await polish?.(action)) || comment));
      await step('transition', () => transitionTo(client, key, src.reviewStatus || 'In Review', { via: src.inProgressStatus || 'In Progress', soft: true }));
      return;
    }
    case 'failed':
      await step('comment', () => addComment(client, key, comment));
      await step('labels', () => changeLabels(client, key, { add: [src.failedLabel || 'AC:Issue'] }));
      return;
    default:
      throw new JiraError(`Unbekannte Aktion ${action.type}`);
  }
}
