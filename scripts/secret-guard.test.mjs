import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { privateGitPath } from './secret-guard.mjs';

const script = fileURLToPath(new URL('./secret-guard.mjs', import.meta.url));
test('private paths are blocked with one exact fake-auth fixture exception', () => {
  for (const path of ['.env', 'apps/api/.env.production', 'auth.json', 'other/tests/fixtures/auth.json', 'backup.dump', 'uploads/photo.jpg', 'key.pem', '.originpost-install/compose.private.json', '.originpost-install/first-login.txt']) assert.equal(privateGitPath(path), true, path);
  for (const path of ['.env.example', 'README.md', 'integrations/hermes/originpost-board-approvals/tests/fixtures/auth.json']) assert.equal(privateGitPath(path), false, path);
});

function fixture(run) {
  const cwd = mkdtempSync(join(homedir(), '.originpost-secret-guard-test-'));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  try {
    git('init');
    git('config', 'user.name', 'Guard Test');
    git('config', 'user.email', 'guard@example.invalid');
    copyFileSync(fileURLToPath(new URL('../.gitleaks.toml', import.meta.url)), join(cwd, '.gitleaks.toml'));
    git('add', '.gitleaks.toml');
    git('commit', '-m', 'Initialize test repository');
    run(cwd, git);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
function check(cwd, mode = 'staged') {
  return spawnSync(process.execPath, [script, mode], { cwd, encoding: 'utf8' });
}
test('staging a private file blocks the commit', () => fixture((cwd, git) => {
  writeFileSync(join(cwd, '.env'), 'EXAMPLE=placeholder\n');
  git('add', '.env');
  const result = check(cwd);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Private file paths/);
}));
test('scanner accepts clean changes and rejects a synthetic token without printing it', () => fixture((cwd, git) => {
  writeFileSync(join(cwd, 'example.txt'), 'ordinary project documentation\n');
  git('add', 'example.txt');
  const clean = check(cwd);
  assert.equal(clean.status, 0, clean.stderr + clean.stdout);
  const fakeToken = 'ghp_' + randomBytes(27).toString('base64').replaceAll('+', 'A').replaceAll('/', 'B');
  writeFileSync(join(cwd, 'example.txt'), `github_token = "${fakeToken}"\n`);
  git('add', 'example.txt');
  const result = check(cwd);
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /leaks found/);
  assert.equal((result.stderr + result.stdout).includes(fakeToken), false);
  git('commit', '-m', 'Synthetic history fixture');
  writeFileSync(join(cwd, 'example.txt'), 'removed token\n');
  git('add', 'example.txt');
  git('commit', '-m', 'Remove fixture token');
  assert.equal(check(cwd, 'history').status, 1, 'Removing a token from HEAD must not bypass history scanning');
}));
