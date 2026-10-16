import fs from 'node:fs';
import path from 'node:path';
import { sh } from './util.mjs';

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
  checkoutTaskBranch(wt, branch) {
    const { remote, integrationBranch } = this.cfg;
    this.fetch();
    if (this.branchExists(`refs/heads/${branch}`)) {
      this.git(wt, ['switch', branch]);
      if (this.branchExists(`refs/remotes/${remote}/${branch}`)) {
        this.git(wt, ['merge', '--ff-only', `${remote}/${branch}`], { check: false });
      }
    } else if (this.branchExists(`refs/remotes/${remote}/${branch}`)) {
      this.git(wt, ['switch', '-c', branch, '--track', `${remote}/${branch}`]);
    } else {
      this.git(wt, ['switch', '-c', branch, integrationBranch]);
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
