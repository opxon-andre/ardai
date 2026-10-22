import { spawn, spawnSync } from 'node:child_process';

// AgentRun creates a separate POSIX process group. Never signal our own group or
// accept special kill(2) PIDs such as 0 and -1.
export function killTree(pid, { platform = process.platform, kill = process.kill, run = spawnSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
  if (platform === 'win32') {
    return run('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true }).status === 0;
  }
  try { kill(-pid, 'SIGKILL'); return true; }
  catch (error) {
    if (error.code !== 'ESRCH') return false;
    // Also support an old saved PID that is not a process-group leader.
    try { kill(pid, 'SIGKILL'); return true; } catch { return false; }
  }
}

export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export function openBrowser(url, { platform = process.platform, env = process.env, launch = spawn, onError = () => {} } = {}) {
  // A headless server still prints its URL; opening a browser is optional.
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const [command, args] = platform === 'win32'
    ? ['cmd.exe', ['/c', 'start', '""', url]]
    : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = launch(command, args, { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.once('error', onError);
  child.once('exit', (code) => { if (code) onError(new Error(`${command}: exit ${code}`)); });
  child.unref();
  return true;
}

const shellQuote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;
export function cliLaunchers(script, { platform = process.platform, node = process.execPath } = {}) {
  const shellPath = (value) => platform === 'win32' ? value.replace(/\\/g, '/') : value;
  const launchers = { '': `#!/bin/sh\nexec ${shellQuote(shellPath(node))} ${shellQuote(shellPath(script))} "$@"\n` };
  if (platform === 'win32') launchers['.cmd'] = `@echo off\r\n"${node}" "${script}" %*\r\n`;
  return launchers;
}
