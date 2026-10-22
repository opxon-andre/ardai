// Explicit integration test: node test/container-smoke.mjs [image]
// Uses only disposable fixtures and never calls an agent/model API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const image = process.argv[2] || 'ardai:local';
const root = fs.mkdtempSync(new URL('.container-', import.meta.url));
const name = `ardai-smoke-${process.pid}-${Date.now()}`;
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  return result.stdout.trim();
}
const exec = (code) => docker(['exec', name, 'node', '--input-type=module', '-e', code]);
const token = 'container-fixture-token-123456789';
const request = `const url = 'http://127.0.0.1:4711/?t=${token}';`;
let started = false;
try {
  for (const dir of ['home', 'secrets', 'project/.orchestrator']) fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o777 });
  for (const dir of ['home', 'project', 'project/.orchestrator']) fs.chmodSync(path.join(root, dir), 0o777);
  fs.writeFileSync(path.join(root, 'secrets', 'ui-token'), token);
  fs.writeFileSync(path.join(root, 'project', '.env'), 'ARDAI_UI_TOKEN_FILE=/run/secrets/ui-token\n');
  fs.writeFileSync(path.join(root, 'project', 'ardai.config.json'), JSON.stringify({ schemaVersion: 2, agents: { claude: { enabled: false }, codex: { enabled: false } } }));
  const state = path.join(root, 'project', '.orchestrator', 'state.json');
  fs.writeFileSync(state, JSON.stringify({ schemaVersion: 2, tasks: [{ id: 'persisted', status: 'ready' }], agents: {}, questions: [] }), { mode: 0o666 });
  docker(['run', '-d', '--name', name, '--init', '--network', 'none',
    '--mount', `type=bind,source=${path.join(root, 'project')},target=/workspace`,
    '--mount', `type=bind,source=${path.join(root, 'home')},target=/home/node`,
    '--mount', `type=bind,source=${path.join(root, 'secrets')},target=/run/secrets,readonly`, image]);
  started = true;
  const ready = `${request} for(let i=0;i<100;i++){try{const r=await fetch(url);if(r.ok){const html=await r.text();console.log(html.match(/data-ui-instance="(\\d+)"/)[1]);process.exit(0)}}catch{}await new Promise(r=>setTimeout(r,100))}process.exit(1);`;
  const first = exec(ready);
  const inspect = () => JSON.parse(docker(['inspect', name]))[0];
  const originalPid = inspect().State.Pid;
  exec(`import fs from 'node:fs'; fs.writeFileSync('/home/node/persisted','kept'); let rejected=false;try{fs.writeFileSync('/run/secrets/forbidden','x')}catch{rejected=true}if(!rejected)process.exit(1);`);
  exec(`${request} const r=await fetch(new URL('/api/reload',url),{method:'POST',headers:{'X-Orchestrator-Token':'${token}'}});if(!r.ok)process.exit(1);await r.json();`);
  const second = exec(`${request} for(let i=0;i<100;i++){try{const r=await fetch(url);const h=await r.text();const p=h.match(/data-ui-instance="(\\d+)"/)?.[1];if(r.ok&&p&&p!=='${first}'){console.log(p);process.exit(0)}}catch{}await new Promise(r=>setTimeout(r,100))}process.exit(1);`);
  assert.notEqual(second, first);
  assert.equal(inspect().State.Pid, originalPid, 'Reload must not restart the container');
  assert.equal(inspect().RestartCount, 0);
  docker(['restart', name]);
  exec(ready);
  exec(`import fs from 'node:fs';if(fs.readFileSync('/home/node/persisted','utf8')!=='kept')process.exit(1);`);
  assert.equal(JSON.parse(fs.readFileSync(state)).tasks[0].id, 'persisted');
  console.log('Container smoke test passed: non-root startup, file secret, read-only secrets, in-container reload and bind-mount persistence.');
} finally {
  if (started) docker(['rm', '-f', name]);
  assert.equal(path.dirname(root), path.resolve(fileURLToPath(new URL('.', import.meta.url))));
  fs.rmSync(root, { recursive: true, force: true });
}
