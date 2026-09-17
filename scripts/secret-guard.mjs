import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function privateGitPath(path) {
  const name = path.replaceAll('\\', '/');
  // This exact fixture contains only test-access/test-refresh; Gitleaks still scans its contents.
  if (name === 'integrations/hermes/originpost-board-approvals/tests/fixtures/auth.json') return false;
  return /(^|\/)\.env(?:\.|$)/i.test(name) && !/(^|\/)\.env\.example$/.test(name)
    || /(^|\/)(?:secrets?|credentials?|cookies?|sessions?|auth)\.(?:json|ya?ml|toml|txt)$/i.test(name)
    || /\.(?:pem|key|p12|pfx|keystore|sqlite3?|dump)$/i.test(name)
    || /(^|\/)(?:data|uploads|postgres-data|minio-data|redis-data|\.ssh|\.aws|\.config)\//i.test(name);
}
export function scan(mode, cwd = process.cwd()) {
  if (!['staged', 'history'].includes(mode)) throw new Error('Use secret-guard.mjs staged|history.');
  const files = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
  if (mode === 'history') files.push(...execFileSync('git', ['log', '--all', '--format=', '--name-only', '-z'], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split(/[\0\n]/).filter(Boolean));
  const blocked = [...new Set(files.filter(privateGitPath))];
  if (blocked.length) throw new Error(`Private file paths are tracked or present in history: ${blocked.slice(0, 20).join(', ')}. Stop and resolve before pushing.`);
  const args = ['git', '--config', '.gitleaks.toml', '--redact=100', '--no-banner', '--no-color', '--ignore-gitleaks-allow', ...(mode === 'staged' ? ['--pre-commit', '--staged'] : ['--log-opts=--all']), '.'];
  const local = spawnSync('gitleaks', ['version'], { stdio: 'ignore' });
  const result = local.status === 0
    ? spawnSync('gitleaks', args, { cwd, stdio: 'inherit' })
    : spawnSync('docker', ['run', '--rm', '-v', `${cwd}:/repo:ro`, '-w', '/repo', 'zricethezav/gitleaks:v8.28.0', ...args], { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Secret scan failed or is unavailable. Commit/push blocked; do not bypass it.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { scan(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
