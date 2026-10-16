import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_BRAND = Object.freeze(JSON.parse(fs.readFileSync(new URL('../brand.json', import.meta.url), 'utf8')));
export const ORCHESTRATOR_AGENT = 'orchestrator';
export const isOrchestratorAgent = (agent, brand = DEFAULT_BRAND) => [ORCHESTRATOR_AGENT, ...brand.legacyNames.agentIds].includes(agent);

export function resolveBrand(override = {}, base = DEFAULT_BRAND) {
  if (typeof override === 'string') override = { name: override, cli: override, processName: override, aliases: [...new Set([base.cli, ...base.aliases])].filter((name) => name !== override) };
  if (!override || typeof override !== 'object' || Array.isArray(override)) throw new Error('brand: expected a name or object');
  const brand = { ...base, ...override, legacyNames: { ...base.legacyNames, ...override.legacyNames } };
  if (override.legacyNames !== undefined && (!override.legacyNames || typeof override.legacyNames !== 'object' || Array.isArray(override.legacyNames))) throw new Error('brand.legacyNames: expected an object');
  for (const key of Object.keys(DEFAULT_BRAND.legacyNames)) {
    const names = brand.legacyNames[key];
    if (!Array.isArray(names) || !names.every((s) => typeof s === 'string' && s.trim())) throw new Error(`brand.legacyNames.${key}: expected non-empty strings`);
    if (['configFiles', 'protocolFiles'].includes(key) && names.some((s) => path.basename(s) !== s || /[\\/]/.test(s))) throw new Error(`brand.legacyNames.${key}: expected filenames`);
  }
  for (const key of Object.keys(DEFAULT_BRAND).filter((k) => !['aliases', 'legacyNames'].includes(k))) {
    if (typeof brand[key] !== 'string' || !brand[key].trim()) throw new Error(`brand.${key}: expected a non-empty string`);
  }
  if (!Array.isArray(brand.aliases) || ![brand.cli, ...brand.aliases].every((s) => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(s))) {
    throw new Error('brand: CLI and aliases must be simple command names');
  }
  for (const key of ['configFile', 'protocolAddendum']) {
    if (path.basename(brand[key]) !== brand[key] || /[\\/]/.test(brand[key])) throw new Error(`brand.${key}: expected a filename`);
  }
  return brand;
}

export const cliNames = (brand = DEFAULT_BRAND) => [...new Set([brand.cli, ...brand.aliases])];
export const stoppedLabels = (brand = DEFAULT_BRAND) => [...new Set([brand.stoppedLabel, DEFAULT_BRAND.stoppedLabel, ...brand.legacyNames.stoppedLabels])];
export const hasStoppedLabel = (labels = [], brand = DEFAULT_BRAND) => labels.some((label) => stoppedLabels(brand).includes(label));
export function protocolAddendum(root, brand = DEFAULT_BRAND, configuredPath) {
  if (configuredPath !== undefined && (typeof configuredPath !== 'string' || !configuredPath.trim())) {
    throw new Error('protocolAddendum: expected a non-empty project-relative path');
  }
  const names = configuredPath === undefined ? [brand.protocolAddendum, ...brand.legacyNames.protocolFiles] : [configuredPath];
  for (const name of names) {
    const relative = path.relative(root, path.resolve(root, name));
    if (path.isAbsolute(name) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error('protocolAddendum: expected a project-relative path within the project');
    }
  }
  const file = names.map((name) => path.join(root, name)).find((p) => fs.existsSync(p));
  return file ? fs.readFileSync(file, 'utf8') : '';
}

// Relative override paths resolve from the caller, before project discovery.
export function loadToolBrand({ cwd = process.cwd(), env = process.env } = {}) {
  return env.ARDAI_BRAND_FILE
    ? resolveBrand(JSON.parse(fs.readFileSync(path.resolve(cwd, env.ARDAI_BRAND_FILE), 'utf8')))
    : resolveBrand();
}
