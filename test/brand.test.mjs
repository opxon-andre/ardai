import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DEFAULT_BRAND, resolveBrand, protocolAddendum, hasStoppedLabel, ORCHESTRATOR_AGENT } from '../lib/brand.mjs';
import { loadProject, CONFIG_NAME } from '../lib/project.mjs';
import { makeT } from '../lib/i18n.mjs';
import { buildReportHtml } from '../lib/report.mjs';
import { collectHints, hintsMarkdown } from '../lib/hints.mjs';
import { sourceActionPrompt } from '../lib/sources.mjs';
import { taskPrompt, resumePrompt, importPrompt } from '../lib/prompts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = fileURLToPath(new URL('../orchestrator.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(here, '.brand-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function json(root, name, value) { fs.writeFileSync(path.join(root, name), JSON.stringify(value)); }
function run(root, ...args) {
  const env = { ...process.env };
  delete env.ORCHESTRATOR_CONFIG;
  delete env.ARDAI_BRAND_FILE;
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
}
const state = () => ({ tasks: [], agents: { codex: {} }, questions: [], testResults: [] });

test('default and private branding drive help, console, reports and hints', (t) => {
  const root = fixture(t);
  for (const brand of [undefined, 'demo-alias', { name: 'Example', cli: 'example', processName: 'example' }]) {
    json(root, CONFIG_NAME, { brand });
    const expected = resolveBrand(brand);
    const help = run(root, '--help');
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, new RegExp(expected.name));
    assert.ok(help.stdout.includes(`${expected.cli} work`));
    const consoleOutput = run(root, 'status');
    assert.equal(consoleOutput.status, 0, consoleOutput.stderr);
    assert.ok(consoleOutput.stdout.includes(`${expected.cli} log -f`));
    const report = run(root, 'report');
    assert.equal(report.status, 0, report.stderr);
    const html = fs.readFileSync(path.join(root, '.orchestrator', 'report.html'), 'utf8');
    assert.ok(html.includes(`<title>${expected.name} – Status</title>`));
    if (!brand) {
      assert.doesNotMatch(help.stdout.split('\n').filter((s) => !s.startsWith('Alias:')).join('\n'), /demo-alias/i);
      assert.doesNotMatch(consoleOutput.stdout + consoleOutput.stderr + report.stdout + html, /demo-alias/i);
      assert.doesNotMatch(fs.readFileSync(path.join(root, '.orchestrator', 'hints.md'), 'utf8'), /demo-alias/i);
    }
  }
});

test('English and German texts and interactive reports use the selected brand', () => {
  const keys = [...fs.readFileSync(new URL('../lib/i18n.mjs', import.meta.url), 'utf8').matchAll(/^\s+'([^']+)':/gm)].map((m) => m[1]);
  for (const language of ['en', 'de']) {
    const t = makeT(language);
    for (const key of keys) assert.doesNotMatch(t(key), /demo-alias|\{app\}|\{cli\}/i);
    assert.match(makeT(language, resolveBrand('demo-alias'))('ui.title'), /demo-alias/);
    const s = state();
    s.questions = [{ id: 'Q1', taskId: 'TASK-1', question: 'Question', blocking: true }, { id: 'Q2', taskId: 'TASK-1', question: 'Hint', agent: 'codex' }];
    const options = { capacity: { codex: { windows: [{ label: 'quota', percent: 20 }] } } };
    assert.doesNotMatch(buildReportHtml(s, options), /demo-alias/i);
    const html = buildReportHtml(s, { ...options, ui: { t, token: 'test', runnerAlive: true } });
    assert.doesNotMatch(html, /demo-alias|\{app\}/i);
    assert.match(html, /<title>ardai/);
    assert.doesNotMatch(buildReportHtml(s, { brand: { name: '<img>', cli: 'example' }, ...options }), /<img>/);
  }
});

test('legacy config and protocol fallback preserve project state; public files take precedence', (t) => {
  const root = fixture(t);
  json(root, 'tool-brand.json', { legacyNames: {"configFiles":["old.config.json"],"protocolFiles":["old.protocol.md"],"stoppedLabels":["old:stopped"],"agentIds":["old-runner"]} });
  const env = { ARDAI_BRAND_FILE: 'tool-brand.json' };
  json(root, 'old.config.json', { brand: 'demo-alias' });
  const p = loadProject({ cwd: root, env });
  assert.equal(p.config.brand.name, 'demo-alias');
  assert.equal(p.runtimeDir, path.join(root, '.orchestrator'));
  assert.equal(path.basename(p.projectFile), 'old.config.json');
  const legacyCli = spawnSync(process.execPath, [cli, 'status'], { cwd: root, env: { ...process.env, ...env, ARDAI_BRAND_FILE: path.join(root, 'tool-brand.json') }, encoding: 'utf8', windowsHide: true });
  assert.equal(legacyCli.status, 0, legacyCli.stderr);
  assert.match(legacyCli.stdout, /demo-alias log -f/);
  fs.writeFileSync(path.join(root, 'old.protocol.md'), 'legacy protocol');
  assert.equal(protocolAddendum(root, p.config.brand), 'legacy protocol');
  fs.writeFileSync(path.join(root, 'ardai.protocol.md'), 'public protocol');
  assert.equal(protocolAddendum(root, p.config.brand), 'public protocol');
  fs.writeFileSync(path.join(root, 'custom.md'), 'custom protocol');
  assert.equal(protocolAddendum(root, resolveBrand({ protocolAddendum: 'custom.md' })), 'custom protocol');
  const prompt = taskPrompt({ task: { id: 'TASK-1', domain: [] }, agent: 'codex', otherTasks: [], protocolAddendum: protocolAddendum(root, p.config.brand) });
  assert.match(prompt, /public protocol/);
  assert.match(resumePrompt({ id: 'TASK-1' }, protocolAddendum(root, p.config.brand)), /public protocol/);
  json(root, CONFIG_NAME, {});
  assert.equal(loadProject({ cwd: root, env: {} }).config.brand.name, 'ardai');
});

test('stop and resume retain legacy labels and mark imported tasks stopped', (t) => {
  const root = fixture(t);
  json(root, CONFIG_NAME, { ui: { enabled: false }, brand: { legacyNames: {"configFiles":["old.config.json"],"protocolFiles":["old.protocol.md"],"stoppedLabels":["old:stopped"],"agentIds":["old-runner"]} } });
  const config = loadProject({ cwd: root, env: {} }).config;
  assert.equal(config.source.stoppedLabel, 'ardai:stopped');
  assert.equal(hasStoppedLabel(['old:stopped'], config.brand), true);
  assert.equal(hasStoppedLabel(['ardai:stopped']), true);
  assert.equal(hasStoppedLabel(['other']), false);
  assert.match(importPrompt({ keys: ['TASK-1'] }, 'out.json', config), /old:stopped/);
  for (const type of ['cleaned', 'resumed']) {
    const prompt = sourceActionPrompt({ taskId: 'TASK-1', type, branch: 'task/TASK-1' }, config.source, makeT(), 'out.json');
    assert.match(prompt, /Remove all.*ardai:stopped.*old:stopped/);
  }
  json(root, 'tasks.json', [{ id: 'TASK-1', labels: ['old:stopped'] }, { id: 'TASK-2', labels: ['ardai:stopped'] }, { id: 'TASK-3' }]);
  const result = run(root, 'import', '--file', path.join(root, 'tasks.json'));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.orchestrator', 'state.json'))).tasks.map((s) => s.status), ['stopped', 'stopped', 'ready']);
  json(root, 'tasks.json', [{ id: 'TASK-3', labels: ['old:stopped'] }]);
  assert.equal(run(root, 'import', '--file', path.join(root, 'tasks.json')).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.orchestrator', 'state.json'))).tasks.find((s) => s.id === 'TASK-3').status, 'stopped');
});

test('orchestrator hints have a stable sender and recognize legacy senders', () => {
  assert.equal(ORCHESTRATOR_AGENT, 'orchestrator');
  const s = state();
  const brand = resolveBrand({ legacyNames: { agentIds: ['old-runner'] } });
  s.questions = ['old-runner', ORCHESTRATOR_AGENT, 'codex'].map((agent, i) => ({ id: `Q${i}`, agent, question: 'hint' }));
  assert.deepEqual(collectHints(s, brand).map((q) => q.agent), ['codex']);
  assert.doesNotMatch(hintsMarkdown(s, brand), /old-runner/);
});

test('installer creates identical executable wrappers for CLI and all aliases', (t) => {
  const root = fixture(t);
  for (const brand of [undefined, { cli: 'example', aliases: ['alternate', 'ardai'] }]) {
    json(root, CONFIG_NAME, { brand });
    const target = path.join(root, brand ? 'custom-bin' : 'bin');
    const install = run(root, 'install-cli', target);
    assert.equal(install.status, 0, install.stderr);
    const expected = resolveBrand(brand);
    for (const suffix of process.platform === 'win32' ? ['', '.cmd'] : ['']) {
      const content = fs.readFileSync(path.join(target, `${expected.cli}${suffix}`), 'utf8');
      for (const alias of expected.aliases) assert.equal(fs.readFileSync(path.join(target, alias + suffix), 'utf8'), content);
    }
    if (process.platform === 'win32') {
      for (const name of [expected.cli, ...expected.aliases]) {
        const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${path.join(target, name + '.cmd')}" --help"`], { cwd: root, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /Orchestrator/);
      }
    } else {
      for (const name of [expected.cli, ...expected.aliases]) {
        const launcher = path.join(target, name);
        assert.ok(fs.statSync(launcher).mode & 0o111);
        const r = spawnSync(launcher, ['--help'], { cwd: root, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /Orchestrator/);
      }
    }
  }
});

test('brand defaults contain no project data and invalid command names are rejected', () => {
  assert.doesNotMatch(JSON.stringify(DEFAULT_BRAND), /atlassian|cloudId|jira/i);
  for (const value of [{ cli: '../bad' }, { aliases: ['a;exit'] }, { protocolAddendum: '../bad' }, { name: '' }]) assert.throws(() => resolveBrand(value), /brand/);
});

test('help works without a project and brand runtime directory overrides the default', (t) => {
  const root = fixture(t);
  const result = run(path.parse(root).root, '--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ardai work/);
  json(root, CONFIG_NAME, { brand: { runtimeDir: 'brand-runtime' } });
  assert.equal(loadProject({ cwd: root, env: {} }).runtimeDir, path.join(root, 'brand-runtime'));
  json(root, CONFIG_NAME, { brand: { runtimeDir: 'brand-runtime' }, runtimeDir: 'project-runtime' });
  assert.equal(loadProject({ cwd: root, env: {} }).runtimeDir, path.join(root, 'project-runtime'));
});

test('the CLI sets the configured process name', (t) => {
  const root = fixture(t);
  json(root, CONFIG_NAME, { brand: { processName: 'example-runner' } });
  const env = { ...process.env };
  delete env.ORCHESTRATOR_CONFIG;
  const code = `process.argv = [process.execPath, ${JSON.stringify(cli)}, 'status']; await import(${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)}); console.log('TITLE=' + process.title);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TITLE=example-runner/);
});


test('tool overrides bootstrap discovery, preserve lists and allow project replacements', (t) => {
  const root = fixture(t);
  json(root, 'tool.json', { cli: 'demo-tool', aliases: ['demo-alias'], legacyNames: { configFiles: ['first.config.json', 'old.config.json'], protocolFiles: ['old.protocol.md'], agentIds: ['old-runner'] } });
  json(root, 'old.config.json', { brand: { aliases: [], legacyNames: { stoppedLabels: ['old:stopped'] } } });
  const options = { cwd: root, env: { ARDAI_BRAND_FILE: 'tool.json' } };
  assert.throws(() => loadProject({ cwd: root, env: {} }), /No ardai.config.json/);
  const project = loadProject(options);
  assert.equal(project.config.brand.cli, 'demo-tool');
  assert.deepEqual(project.config.brand.aliases, []);
  assert.deepEqual(project.config.brand.legacyNames.protocolFiles, ['old.protocol.md']);
  assert.deepEqual(project.config.brand.legacyNames.stoppedLabels, ['old:stopped']);
  assert.equal(project.brandFile, path.join(root, 'tool.json'));
  json(root, CONFIG_NAME, {});
  assert.equal(loadProject(options).projectFile, path.join(root, CONFIG_NAME));
});

test('tool branding drives help and launchers without a project', (t) => {
  const root = fixture(t);
  json(root, 'tool.json', { name: 'Demo', cli: 'demo-tool', aliases: ['demo-alias'] });
  const env = { ...process.env, ARDAI_BRAND_FILE: path.join(root, 'tool.json') };
  delete env.ORCHESTRATOR_CONFIG;
  for (const args of [['--help'], ['install-cli', path.join(root, 'bin')]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /demo-tool/);
  }
  for (const name of ['demo-tool', 'demo-alias']) assert.ok(fs.existsSync(path.join(root, 'bin', name + (process.platform === 'win32' ? '.cmd' : ''))));
});

test('legacy lists validate entries and internal senders are filtered in reports', () => {
  for (const legacyNames of [null, [], { configFiles: ['../old.json'] }, { protocolFiles: ['a/b.md'] }, { stoppedLabels: [''] }, { agentIds: 'old-runner' }]) {
    assert.throws(() => resolveBrand({ legacyNames }), /brand/);
  }
  const brand = resolveBrand({ legacyNames: { agentIds: ['old-runner'] } });
  const s = state();
  s.questions = [{ agent: 'old-runner', question: 'internal-message', blocking: false }];
  assert.match(buildReportHtml(s), /internal-message/);
  assert.doesNotMatch(buildReportHtml(s, { brand }), /internal-message/);
  assert.deepEqual(collectHints(s, brand), []);
  assert.equal(hasStoppedLabel(['old:stopped']), false);
});
