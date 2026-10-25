import fs from 'node:fs';
import path from 'node:path';
import { sh, shAsync } from './util.mjs';

export function renderPrePushHook(template, worktreeRoot) {
  const root = worktreeRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const quoted = `'${root.replace(/'/g, `'"'"'`)}'`;
  return template.replace(/\r\n/g, '\n').replace('__ARDAI_WORKTREE_ROOT__', () => quoted);
}

export class Git {
  constructor(repoRoot, config) {
    this.repoRoot = repoRoot;
    this.cfg = config;
    this.worktreeRoot = path.resolve(repoRoot, config.worktreeRoot);
  }

  git(cwd, args, opts) {
    return sh('git', ['-C', cwd, ...args], opts);
  }

  worktreePath(name) {
    return path.join(this.worktreeRoot, name);
  }

  branchExists(ref) {
    return this.git(this.repoRoot, ['rev-parse', '--verify', '--quiet', ref], { check: false }).code === 0;
  }

  fetch() {
    this.git(this.repoRoot, ['fetch', '--prune', this.cfg.remote], { check: false });
  }

  mergedBranches(base = this.cfg.baseBranch) {
    const result = this.git(this.repoRoot, ['for-each-ref', '--format=%(refname)', '--merged', base, 'refs/heads/'], { check: false });
    return new Set(result.code === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : []);
  }

  ensureIntegrationBranch() {
    const { integrationBranch: ib, baseBranch, remote } = this.cfg;
    if (!this.branchExists(`refs/heads/${ib}`)) {
      const start = this.branchExists(`refs/remotes/${remote}/${ib}`) ? `${remote}/${ib}` : baseBranch;
      this.git(this.repoRoot, ['branch', ib, start]);
    }
  }

  ensureWorktree(name, ref) {
    const wt = this.worktreePath(name);
    if (fs.existsSync(path.join(wt, '.git'))) return wt;
    fs.mkdirSync(this.worktreeRoot, { recursive: true });
    const args = ref ? ['worktree', 'add', wt, ref] : ['worktree', 'add', '--detach', wt, this.cfg.integrationBranch];
    this.git(this.repoRoot, args);
    return wt;
  }

  isDirty(wt) {
    return this.git(wt, ['status', '--porcelain']).stdout.length > 0;
  }

  currentBranch(wt) {
    return this.git(wt, ['branch', '--show-current']).stdout;
  }

  // Bringt den Agent-Worktree auf den Task-Branch. Existiert der Branch remote
  // schon (z. B. weil der andere Agent vor einem Outage gepusht hat), wird von
  // dort fortgesetzt, sonst neu von integration abgezweigt.
  async checkoutTaskBranch(wt, branch) {
    const { remote, integrationBranch } = this.cfg;
    const run = (cwd, args, opts) => shAsync('git', ['-C', cwd, ...args], opts);
    const exists = async (ref) => (await run(this.repoRoot, ['rev-parse', '--verify', '--quiet', ref], { check: false })).code === 0;
    await run(this.repoRoot, ['fetch', '--prune', remote], { check: false });
    if (await exists(`refs/heads/${branch}`)) {
      await run(wt, ['switch', branch]);
      if (await exists(`refs/remotes/${remote}/${branch}`)) {
        await run(wt, ['merge', '--ff-only', `${remote}/${branch}`], { check: false });
      }
    } else if (await exists(`refs/remotes/${remote}/${branch}`)) {
      await run(wt, ['switch', '-c', branch, '--track', `${remote}/${branch}`]);
    } else {
      await run(wt, ['switch', '-c', branch, integrationBranch]);
    }
  }

  // Sichert nach Outage/Abbruch alles, was der Agent nicht mehr committen
  // konnte, und gibt den Branch frei, damit der andere Worktree ihn auschecken kann.
  autosaveAndRelease(wt, branch, reason) {
    if (!branch || this.currentBranch(wt) !== branch) {
      this.git(wt, ['switch', '--detach'], { check: false });
      return false;
    }
    let saved = false;
    if (this.isDirty(wt)) {
      this.git(wt, ['add', '-A']);
      this.git(wt, ['commit', '--no-verify', '-m', `wip(orchestrator): Autosave nach ${reason}`]);
      saved = true;
    }
    this.git(wt, ['push', '-u', this.cfg.remote, branch], { check: false });
    this.git(wt, ['switch', '--detach']);
    return saved;
  }

  // Sichert den Arbeitsstand eines laufenden Agenten unter refs/ardai/wip/<task>, ohne Branch, Index oder
  // Arbeitsverzeichnis des Agenten anzufassen: temporärer Index, Commit mit Task-Branch-HEAD als Elternteil.
  // Gibt den Commit zurück, oder null, wenn sich seit dem letzten Checkpoint nichts geändert hat.
  checkpoint(wt, taskId) {
    const ref = `refs/ardai/wip/${taskId}`;
    const gitDir = path.resolve(wt, this.git(wt, ['rev-parse', '--git-dir']).stdout);
    const index = path.join(gitDir, `ardai-wip-${process.pid}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
      const head = this.git(wt, ['rev-parse', '--verify', '--quiet', 'HEAD'], { check: false });
      if (head.code === 0) this.git(wt, ['read-tree', 'HEAD'], { env });
      this.git(wt, ['add', '-A'], { env });
      const tree = this.git(wt, ['write-tree'], { env }).stdout;
      const previous = this.git(wt, ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], { check: false });
      const base = head.code === 0 ? head.stdout : null;
      const baseTree = base ? this.git(wt, ['rev-parse', `${base}^{tree}`]).stdout : null;
      if (previous.code === 0 ? previous.stdout === tree : baseTree === tree) return null;
      const message = `wip(${taskId}): Checkpoint ${new Date().toISOString()}`;
      const commit = this.git(wt, ['commit-tree', tree, ...(base ? ['-p', base] : []), '-m', message], { env }).stdout;
      this.git(wt, ['update-ref', ref, commit]);
      this.git(wt, ['push', '-q', '--force', this.cfg.remote, `${ref}:${ref}`], { check: false });
      return commit;
    } finally {
      fs.rmSync(index, { force: true });
    }
  }

  mergeIntoIntegration(branch, message) {
    const { integrationBranch, remote } = this.cfg;
    const wt = this.ensureWorktree('integration');
    if (this.currentBranch(wt) !== integrationBranch) this.git(wt, ['switch', integrationBranch]);
    if (this.branchExists(`refs/remotes/${remote}/${integrationBranch}`)) {
      this.git(wt, ['merge', '--ff-only', `${remote}/${integrationBranch}`], { check: false });
    }
    const res = this.git(wt, ['merge', '--no-ff', '-m', message, branch], { check: false });
    if (res.code !== 0) {
      this.git(wt, ['merge', '--abort'], { check: false });
      return { ok: false, detail: res.stdout || res.stderr };
    }
    this.git(wt, ['push', remote, integrationBranch], { check: false });
    return { ok: true };
  }
}
