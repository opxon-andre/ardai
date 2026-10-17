// Direct Jira Cloud REST access for status, comment and label updates.
// No language model is involved: these are plain HTTPS calls made by ardai itself, so they cost no agent tokens.
// Credentials: Atlassian account e-mail + API token (id.atlassian.com → Security → API tokens).
// The token is read from a git-ignored file or the environment and never handed to agents.
import fs from 'node:fs';
import path from 'node:path';

export class JiraError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
    this.retryable = retryable;
  }
}

export function loadJiraAuth({ config, repoRoot, env = process.env } = {}) {
  const src = config?.source || {};
  const baseUrl = String(config?.jiraBaseUrl || '').trim().replace(/\/+$/, '');
  const email = String(env.ARDAI_JIRA_EMAIL || src.jiraEmail || '').trim();
  let token = String(env.ARDAI_JIRA_TOKEN || '').trim();
  if (!token && src.tokenFile) {
    const file = path.resolve(repoRoot || '.', src.tokenFile);
    try { token = fs.readFileSync(file, 'utf8').trim(); } catch { /* not configured */ }
  }
  if (!baseUrl || !email || !token || /\s/.test(token)) return null;
  return { baseUrl, email, token };
}

export class JiraClient {
  constructor({ baseUrl, email, token, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
    Object.assign(this, { baseUrl, fetchImpl, timeoutMs });
    this.authorization = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    this.secret = token;
  }

  async request(method, apiPath, body) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
        method,
        headers: { authorization: this.authorization, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new JiraError(`Jira nicht erreichbar: ${String(err.message || err).replaceAll(this.secret, '[redacted]')}`, { retryable: true });
    }
    const text = await response.text();
    if (!response.ok) {
      const detail = text.replaceAll(this.secret, '[redacted]').slice(0, 300);
      const retryable = response.status === 429 || response.status >= 500;
      const hint = response.status === 401 || response.status === 403 ? ' (E-Mail/API-Token prüfen)' : '';
      throw new JiraError(`Jira ${method} ${apiPath.split('?')[0]}: HTTP ${response.status}${hint} ${detail}`.trim(), { status: response.status, retryable });
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

export async function transitionTo(client, key, statusName) {
  const issue = await client.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`);
  const current = issue?.fields?.status?.name;
  if (current && current.toLowerCase() === statusName.toLowerCase()) return { changed: false, status: current };
  const list = await client.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  const match = (list?.transitions || []).find((tr) => tr.to?.name?.toLowerCase() === statusName.toLowerCase() || tr.name?.toLowerCase() === statusName.toLowerCase());
  if (!match) {
    const names = (list?.transitions || []).map((tr) => tr.to?.name || tr.name).join(', ') || '(keine)';
    throw new JiraError(`${key}: kein Übergang nach "${statusName}" von "${current}" möglich (verfügbar: ${names}).`);
  }
  await client.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: match.id } });
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
export async function applyAction(client, action, { src = {}, t, polish } = {}) {
  const key = action.taskId;
  const stopped = [...new Set([src.stoppedLabel, ...(src.stoppedLabels || [])].filter(Boolean))];
  const comment = action.comment || t(`jira.comment.${action.type}`, { task: key, branch: action.branch });
  switch (action.type) {
    case 'stopped':
      await addComment(client, key, comment);
      await changeLabels(client, key, { add: stopped.slice(0, 1) });
      return;
    case 'cleaned':
      await addComment(client, key, comment);
      await transitionTo(client, key, src.todoStatus || 'To Do');
      await changeLabels(client, key, { remove: stopped });
      return;
    case 'resumed':
      await addComment(client, key, comment);
      await changeLabels(client, key, { remove: stopped });
      return;
    case 'started':
      await transitionTo(client, key, src.inProgressStatus || 'In Progress');
      return;
    case 'review': {
      const text = (await polish?.(action)) || comment;
      await addComment(client, key, text);
      await transitionTo(client, key, src.reviewStatus || 'In Review');
      return;
    }
    case 'failed':
      await addComment(client, key, comment);
      await changeLabels(client, key, { add: [src.failedLabel || 'AC:Issue'] });
      return;
    default:
      throw new JiraError(`Unbekannte Aktion ${action.type}`);
  }
}
