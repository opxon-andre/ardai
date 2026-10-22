// Optional local language model (Ollama) that rewrites ticket comment drafts. Off by default.
// It only polishes wording: every failure, timeout or implausible answer returns null so that the caller
// falls back to the template text (jira.comment.*). One request at a time, so a CPU-only machine is not flooded.

export const OLLAMA_DEFAULTS = { enabled: false, url: 'http://localhost:11434', model: 'qwen2.5:1.5b', timeoutSeconds: 60, maxChars: 1500 };

const SYSTEM = 'Du formulierst Jira-Kommentare. Fasse den Entwurf knapp und sachlich in der Sprache des Entwurfs zusammen. '
  + 'Erfinde nichts, lasse keine Zahlen, Branch-Namen oder Ticket-Schlüssel weg und ändere sie nicht. Keine Einleitung, nur der Kommentartext.';

// Every identifier-like token of the draft that must survive the rewrite.
function mustKeep(draft, branch) {
  return [...new Set([branch, ...(draft.match(/\b\d+ von \d+\b|\b\d+ of \d+\b/g) || [])].filter(Boolean))];
}

export function createPolisher(options = {}, { fetchImpl = globalThis.fetch } = {}) {
  const cfg = { ...OLLAMA_DEFAULTS, ...options };
  if (!cfg.enabled || !cfg.model) return null;
  const endpoint = `${String(cfg.url).replace(/\/+$/, '')}/api/chat`;
  let busy = false;

  async function rewrite(draft, branch) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        options: { temperature: 0.2 },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: draft }],
      }),
      signal: AbortSignal.timeout(cfg.timeoutSeconds * 1000),
    });
    if (!response.ok) return null;
    const text = String((await response.json())?.message?.content || '').trim();
    if (!text || text.length > cfg.maxChars) return null;
    return mustKeep(draft, branch).every((token) => text.includes(token)) ? text : null;
  }

  // The returned function matches the `polish` callback of applyAction(): (action) => text | null.
  return (action) => {
    const draft = String(action.comment || '').trim();
    // Wording is optional: use the template instead of queueing network writes
    // behind a busy local model. Still never run two model requests at once.
    if (!draft || busy) return Promise.resolve(null);
    busy = true;
    return rewrite(draft, action.branch).catch(() => null).finally(() => { busy = false; });
  };
}
