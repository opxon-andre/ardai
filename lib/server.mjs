import http from 'node:http';
import crypto from 'node:crypto';
import { localAddresses, urlHost } from './network.mjs';

// Local web UI for ardai. Security:
// - binds to 127.0.0.1 by default; remote binding requires explicit configuration
// - Host header must match the bind address, loopback or an explicit allowlist
// - every request needs the random token (stable across restarts when the caller passes a stored one) (?t= for the page, header
//   X-Orchestrator-Token for API/fragment), so other websites open in the browser
//   cannot trigger actions on localhost.

export const ACTIONS = ['stop', 'clean', 'retry', 'answer', 'work', 'overage', 'archive', 'unarchive', 'ack', 'reload'];

export async function startServer({ port, host: bindHost = '127.0.0.1', allowedHosts = [], t, page, fragment, onAction, log, token = crypto.randomBytes(18).toString('base64url') }) {
  let actualPort = port;
  const wildcard = ['0.0.0.0', '::'].includes(bindHost);
  const lanHosts = wildcard ? localAddresses().filter((ip) => bindHost === '::' || !ip.includes(':')) : [];

  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(body);
    };
    const json = (code, obj) => send(code, JSON.stringify(obj), 'application/json; charset=utf-8');
    try {
      const host = req.headers.host || '';
      const address = bindHost.includes(':') ? `[${bindHost}]` : bindHost;
      const authorities = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]);
      for (const ip of lanHosts) authorities.add(`${urlHost(ip)}:${actualPort}`);
      if (!['0.0.0.0', '::'].includes(bindHost)) authorities.add(`${address}:${actualPort}`);
      for (const name of allowedHosts) { authorities.add(name); authorities.add(`${name}:${actualPort}`); }
      if (!authorities.has(host)) return send(403, 'Forbidden host');
      const url = new URL(req.url, `http://${host}`);
      const authed = url.searchParams.get('t') === token || req.headers['x-orchestrator-token'] === token;
      if (!authed) return send(403, `<p>${t('ui.forbidden')}</p>`);

      if (req.method === 'GET' && url.pathname === '/') return send(200, await page(token));
      if (req.method === 'GET' && url.pathname === '/fragment') return send(200, await fragment(token));
      const m = url.pathname.match(/^\/api\/([a-z-]+)$/);
      if (req.method === 'POST' && m && ACTIONS.includes(m[1])) {
        if (req.headers['x-orchestrator-token'] !== token) return json(403, { ok: false, message: t('ui.forbidden') });
        const body = await readBody(req);
        try {
          const result = await onAction(m[1], body);
          const message = typeof result === 'object' ? result.message : result;
          if (typeof result?.afterResponse === 'function') res.once('finish', result.afterResponse);
          if (typeof result?.onCancel === 'function') res.once('close', () => { if (!res.writableFinished) result.onCancel(); });
          return json(200, { ok: true, message });
        } catch (err) {
          return json(400, { ok: false, message: err.message });
        }
      }
      return send(404, 'Not found');
    } catch (err) {
      log?.('UI error:', err.message);
      return send(500, 'Internal error');
    }
  });

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(actualPort, bindHost, () => { server.off('error', reject); resolve(); });
      });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt === 9) throw err;
      log?.(t('serve.busy', { port: actualPort, next: actualPort + 1 }));
      actualPort += 1;
    }
  }
  const publicHost = ['0.0.0.0', '::'].includes(bindHost) ? '127.0.0.1' : bindHost.includes(':') ? `[${bindHost}]` : bindHost;
  return { server, token, port: actualPort, url: `http://${publicHost}:${actualPort}/?t=${token}`,
    lanUrls: lanHosts.map((host) => `http://${urlHost(host)}:${actualPort}/?t=${token}`) };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64_000) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
