import fs from 'node:fs';
import path from 'node:path';

const SECRET_NAMES = ['CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ARDAI_JIRA_EMAIL', 'ARDAI_JIRA_TOKEN', 'ARDAI_UI_TOKEN'];

export function loadEnvironment({ cwd = process.cwd(), env = process.env } = {}) {
  for (const name of (env.ARDAI_DOTENV_KEYS || '').split(',').filter(Boolean)) delete env[name];
  for (const name of (env.ARDAI_FILE_SECRET_NAMES || '').split(',').filter(Boolean)) delete env[name];
  const dotenvKeys = [], secretNames = [];
  const file = path.join(cwd, '.env');
  if (fs.existsSync(file)) {
    const values = process.getBuiltinModule('node:util').parseEnv(fs.readFileSync(file, 'utf8'));
    for (const [name, value] of Object.entries(values)) {
      if (name.startsWith('ARDAI_DOTENV_') || name === 'ARDAI_FILE_SECRET_NAMES') continue;
      if (env[name] === undefined) { env[name] = value; dotenvKeys.push(name); }
    }
  }
  // Compose may pass empty placeholders; let Git fall back to ~/.gitconfig.
  for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    if (env[name] === '') delete env[name];
  }
  for (const name of SECRET_NAMES) {
    if (!env[`${name}_FILE`]) continue;
    if (env[name]) throw new Error(`Configure either ${name} or ${name}_FILE, not both`);
    const value = fs.readFileSync(path.resolve(cwd, env[`${name}_FILE`]), 'utf8').trim();
    if (!value) throw new Error(`${name}_FILE: empty secret file`);
    env[name] = value;
    secretNames.push(name);
  }
  env.ARDAI_DOTENV_KEYS = dotenvKeys.join(',');
  env.ARDAI_FILE_SECRET_NAMES = secretNames.join(',');
}

export function uiEnvironment(config = {}, env = process.env) {
  const host = env.ARDAI_UI_HOST || config.host || '127.0.0.1';
  const port = Number(env.ARDAI_UI_PORT || config.port || 4711);
  const allowedHosts = env.ARDAI_UI_ALLOWED_HOSTS
    ? env.ARDAI_UI_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean) : config.allowedHosts || [];
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ARDAI_UI_PORT / ui.port must be 1–65535');
  if (typeof host !== 'string' || /[\s/]/.test(host)) throw new Error('Invalid UI bind host');
  if (!Array.isArray(allowedHosts) || allowedHosts.some((s) => typeof s !== 'string' || !s || /[\s/*?#@]/.test(s))) throw new Error('Invalid UI allowed hosts');
  return { host, port, allowedHosts };
}
