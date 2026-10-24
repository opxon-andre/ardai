import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './util.mjs';
import { DEFAULT_BRAND, loadToolBrand, resolveBrand, stoppedLabels } from './brand.mjs';

export const SCHEMA_VERSION = 2;
export const CONFIG_NAME = DEFAULT_BRAND.configFile;
const projectConfig = (dir, brand) => [...new Set([CONFIG_NAME, brand.configFile, ...brand.legacyNames.configFiles])].map((name) => path.join(dir, name)).find((file) => fs.existsSync(file));
const defaultsFile = fileURLToPath(new URL('../config.json', import.meta.url));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateVersion(value, file) {
  if (!isObject(value)) throw new Error(`${file}: expected a JSON object / JSON-Objekt erwartet`);
  const version = value.schemaVersion === undefined ? 1 : value.schemaVersion;
  if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) {
    throw new Error(`${file}: unsupported schemaVersion ${version} (supported: 1–${SCHEMA_VERSION}) / nicht unterstützte Schema-Version`);
  }
  return version;
}

export function findProjectRoot(cwd = process.cwd(), brand = loadToolBrand({ cwd })) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (projectConfig(dir, brand)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Objects merge recursively; arrays and scalar values replace the default.
export function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    result[key] = isObject(value) && isObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return result;
}

export function saveConfig(file, config) {
  validateVersion(config, file);
  if (fs.existsSync(file)) validateVersion(readJson(file), file);
  writeJsonAtomic(file, { ...config, schemaVersion: SCHEMA_VERSION });
}

// Resolve after merging all layers so siblings inherit project-specific commands,
// models, credentials and the enabled flag, rather than just the tool defaults.
export function resolveAgents(agents) {
  const resolved = {};
  const visiting = new Set();
  function resolve(name) {
    if (Object.hasOwn(resolved, name)) return resolved[name];
    if (!Object.hasOwn(agents, name)) throw new Error(`Unknown parent agent: ${name}`);
    if (visiting.has(name)) throw new Error(`Agent inheritance cycle: ${name}`);
    visiting.add(name);
    const { extends: parent, ...own } = agents[name];
    const cfg = parent === undefined ? own : deepMerge(resolve(parent), own);
    visiting.delete(name);
    resolved[name] = cfg;
    return cfg;
  }
  // Preserve configured scheduling order even when a parent comes after a child.
  return Object.fromEntries(Object.keys(agents).map((name) => [name, resolve(name)]));
}

export function loadProject({ cwd = process.cwd(), env = process.env, init = false } = {}) {
  const toolBrand = loadToolBrand({ cwd, env });
  let repoRoot = findProjectRoot(cwd, toolBrand);
  if (!repoRoot) {
    if (!init) throw new Error(`No ${CONFIG_NAME} found from ${cwd} upwards / Keine Projekt-Config gefunden. Run / Bitte ausführen: ${DEFAULT_BRAND.cli} init`);
    repoRoot = path.resolve(cwd);
    saveConfig(path.join(repoRoot, CONFIG_NAME), { schemaVersion: SCHEMA_VERSION });
  }
  const projectFile = projectConfig(repoRoot, toolBrand) || path.join(repoRoot, CONFIG_NAME);
  const files = [defaultsFile, projectFile];
  // Keep the environment override as the highest-priority layer. Its location
  // never changes the project root; relative names are relative to the caller.
  const overrideFile = env.ORCHESTRATOR_CONFIG ? path.resolve(cwd, env.ORCHESTRATOR_CONFIG) : null;
  if (overrideFile) files.push(overrideFile);
  let config = {};
  for (const file of files) {
    const layer = readJson(file);
    validateVersion(layer, file);
    config = deepMerge(config, layer);
  }
  config.schemaVersion = SCHEMA_VERSION;
  config.agents = resolveAgents(config.agents);
  if (typeof config.autoStartRunner !== 'boolean') throw new Error('autoStartRunner: expected boolean / Boolean erwartet');
  config.brand = resolveBrand(config.brand, toolBrand);
  config.runtimeDir ??= config.brand.runtimeDir;
  config.source.stoppedLabel ||= config.brand.stoppedLabel;
  config.source.stoppedLabels = [...new Set([config.source.stoppedLabel, ...stoppedLabels(config.brand)])];
  if (!Number.isInteger(config.source.maxConcurrency) || config.source.maxConcurrency < 1 || config.source.maxConcurrency > 32) throw new Error('source.maxConcurrency: expected an integer from 1 to 32');
  if (!Number.isInteger(config.source.requestTimeoutSeconds) || config.source.requestTimeoutSeconds < 1 || config.source.requestTimeoutSeconds > 300) throw new Error('source.requestTimeoutSeconds: expected an integer from 1 to 300');
  if (typeof config.keyPattern !== 'string' || !config.keyPattern) throw new Error('keyPattern: expected a non-empty regex string');
  try { new RegExp(`^(?:${config.keyPattern})$`); }
  catch { throw new Error('keyPattern: invalid regular expression'); }
  if (config.phaseTestLocalSecrets !== null) {
    const rel = config.phaseTestLocalSecrets;
    // A source copied into (and later removed from) a worktree must stay inside it.
    if (typeof rel !== 'string' || !rel || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)
      || rel.split(/[\\/]/).some((part) => ['..', '.', ''].includes(part))) {
      throw new Error('phaseTestLocalSecrets: expected null or a repo-relative directory without traversal');
    }
  }
  const runtimeDir = path.resolve(repoRoot, config.runtimeDir);
  return {
    repoRoot, projectFile, overrideFile, brandFile: env.ARDAI_BRAND_FILE ? path.resolve(cwd, env.ARDAI_BRAND_FILE) : null, config, runtimeDir,
    stateFile: path.join(runtimeDir, 'state.json'),
    reportFile: path.join(runtimeDir, 'report.html'),
    hintsFile: path.join(runtimeDir, 'hints.md'),
    logDir: path.join(runtimeDir, 'logs'),
    lockFile: path.join(runtimeDir, 'run.lock'),
    inboxFile: path.join(runtimeDir, 'inbox.jsonl'),
    resultsDir: path.resolve(repoRoot, config.resultsDir),
  };
}

export function loadState(file) {
  const state = readJson(file, { tasks: [], agents: {}, questions: [], testResults: [], nextQuestion: 1, schemaVersion: SCHEMA_VERSION });
  validateVersion(state, file);
  return { ...state, schemaVersion: SCHEMA_VERSION };
}

export function saveState(file, state) {
  validateVersion(state, file);
  if (fs.existsSync(file)) {
    const version = validateVersion(readJson(file), file);
    if (version < SCHEMA_VERSION) {
      // Exclusive copy: preserve the first migration backup on every later save.
      try { fs.copyFileSync(file, `${file}.bak`, fs.constants.COPYFILE_EXCL); }
      catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
  }
  writeJsonAtomic(file, { ...state, schemaVersion: SCHEMA_VERSION });
}
