import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFile } from 'node:child_process';

// Windows sperrt Dateien kurzzeitig, während ein anderer Prozess sie liest
// (z. B. die Web-Oberfläche den State). Solche Fehler kurz wiederholen.
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return fn(); } catch (err) {
      if (!TRANSIENT.has(err.code) || attempt >= 40) throw err;
      pause(15 + attempt * 5); // insgesamt höchstens ~5 s
    }
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(withRetry(() => fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

// Schreibt erst in eine Temp-Datei und benennt dann um, damit ein Absturz
// mitten im Schreiben nie einen halben State hinterlässt.
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  try {
    withRetry(() => fs.renameSync(tmp, file));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function expandEnv(value) {
  const expanded = value.replace(/%([^%]+)%|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, percent, braces, dollar) => process.env[percent || braces || dollar] ?? match);
  if (expanded === '~') return os.homedir();
  if (/^~[\\/]/.test(expanded)) return path.join(os.homedir(), expanded.slice(2));
  return expanded;
}

export function nowIso() {
  return new Date().toISOString();
}

export function log(...parts) {
  const line = `[${new Date().toLocaleString('de-DE')}] ${parts.join(' ')}`;
  console.log(line);
}

export function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  const out = { code: res.status ?? 1, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
  if (opts.check !== false && out.code !== 0) {
    const err = new Error(`${cmd} ${args.join(' ')} -> ${out.code}\n${out.stderr || out.stdout}`);
    err.result = out;
    throw err;
  }
  return out;
}

export function shAsync(cmd, args, opts = {}) {
  const { check = true, ...options } = opts;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, ...options }, (error, stdout, stderr) => {
      const out = { code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: (stdout || '').trim(), stderr: (stderr || error?.message || '').trim() };
      if (check && out.code !== 0) {
        const failure = new Error(`${cmd} ${args.join(' ')} -> ${out.code}\n${out.stderr || out.stdout}`);
        failure.result = out;
        reject(failure);
      } else resolve(out);
    });
  });
}

export function pathsOverlap(a, b) {
  const norm = (p) => p.replace(/\\/g, '/').replace(/\*+$/, '');
  for (const x of a.map(norm)) {
    for (const y of b.map(norm)) {
      if (x === '' || y === '' || x.startsWith(y) || y.startsWith(x)) return true;
    }
  }
  return false;
}
