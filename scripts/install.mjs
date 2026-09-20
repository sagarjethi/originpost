import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, stat, chown } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

class InstallationError extends Error {}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateDirectory = resolve(root, '.originpost-install');
const composeFile = resolve(privateDirectory, 'compose.private.json');
const manifestFile = resolve(privateDirectory, 'installation.json');
const randomSecret = () => randomBytes(32).toString('hex');
const privateWrite = (path, value) => writeFile(path, value, { mode: 0o600, flag: 'wx' });

// Exported pure transformation makes installer policy testable without running Docker.
export function installationCompose(base, options) {
  const { directory, ownerId, password, secrets, webPort = 3100, apiPort = 4100, uid = 1000, gid = 1000 } = options;
  const result = structuredClone(base);
  result.name = 'originpost-installed';
  for (const [name, service] of Object.entries(result.services)) {
    delete service.profiles;
    delete service.ports;
    if (service.security_opt) {
      service.security_opt = service.security_opt.map(option => option.startsWith('seccomp=./')
        ? `seccomp=${resolve(root, option.slice('seccomp='.length))}` : option);
    }
    if (service.build) {
      service.build.context = root;
      service.build.args = { ...service.build.args, ORIGINPOST_API_UPSTREAM: 'http://api:4000' };
    }
    service.stop_grace_period = '2m';
    if (['api', 'worker'].includes(name)) {
      service.user = `${uid}:${gid}`;
      service.environment = { ...service.environment,
        AUTH_MODE: 'sessions', AUTH_COOKIE_SECURE: 'false',
        BOOTSTRAP_ADMIN_EMAIL: 'installer@originpost.local', BOOTSTRAP_ADMIN_NAME: 'Installation owner', BOOTSTRAP_ADMIN_PASSWORD: password,
        INSTALLATION_OWNER_ID: ownerId, INSTALLATION_WORKSPACE_ID: 'default',
        INSTALLATION_SETTINGS_PATH: '/run/originpost/settings/settings.enc', INSTALLATION_KEY_FILE: '/run/originpost/key/master.key',
        DATABASE_URL: `postgres://originpost:${secrets.database}@postgres:5432/originpost`,
        REVIEW_LINK_SECRET: secrets.review, MEDIA_DELIVERY_SECRET: secrets.media,
        CREDENTIAL_ENCRYPTION_KEY: secrets.credentials, META_WEBHOOK_VERIFY_TOKEN: secrets.webhook,
        PROVIDER_LOOKUP_HMAC_KEYS: `v1:${secrets.lookup}`, PROVIDER_LOOKUP_HMAC_ACTIVE_VERSION: 'v1',
        PROVIDER_DELETION_STATUS_KEY: secrets.deletion,
        S3_SECRET_KEY: secrets.storage, S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:61900',
        API_PUBLIC_URL: `http://127.0.0.1:${apiPort}`, WEB_PUBLIC_URL: `http://127.0.0.1:${webPort}`,
        CORS_ORIGIN: `http://127.0.0.1:${webPort}`, MEDIA_MALWARE_SCAN_MODE: 'clamav',
        CONNECTOR_MODE: 'mock', INSTAGRAM_CONNECTOR_MODE: 'mock', FACEBOOK_CONNECTOR_MODE: 'mock', YOUTUBE_CONNECTOR_MODE: 'mock', ALLOW_LIVE_PUBLISH: 'false',
      };
      service.volumes = [
        { type: 'bind', source: resolve(directory, 'key'), target: '/run/originpost/key', read_only: true },
        { type: 'bind', source: resolve(directory, 'settings'), target: '/run/originpost/settings', read_only: name === 'worker' },
      ];
    }
  }
  result.services.api.command = ['sh', '-c', 'node packages/db/dist/migrate.js && node apps/api/dist/main.js'];
  result.services.worker.command = ['node', 'apps/worker/dist/main.js'];
  result.services.api.ports = [`127.0.0.1:${apiPort}:4000`];
  result.services.web.ports = [`127.0.0.1:${webPort}:3000`];
  result.services.postgres.environment.POSTGRES_PASSWORD = secrets.database;
  result.services.minio.environment.MINIO_ROOT_PASSWORD = secrets.storage;
  result.services.minio.ports = ['127.0.0.1:61900:9000'];
  // Compose's normalized names otherwise reuse the development installation's data volumes.
  for (const volume of Object.values(result.volumes ?? {})) delete volume.name;
  for (const network of Object.values(result.networks ?? {})) delete network.name;
  return result;
}

function docker(args, options = {}) {
  const run = spawnSync('docker', args, { cwd: root, ...options });
  if (run.error || run.status !== 0) throw new InstallationError('Docker could not complete this installation step. Check Docker and the service status.');
  return run;
}

async function prepare() {
  // Never resolve the existing .env or change an existing installation.
  try { await stat(privateDirectory); throw new InstallationError('An installation directory already exists. Use start or apply; it will not be overwritten.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const args of [
    ['ps', '--all', '--filter', 'label=com.docker.compose.project=originpost-installed', '--format', '{{.ID}}'],
    ['volume', 'ls', '--filter', 'label=com.docker.compose.project=originpost-installed', '--format', '{{.Name}}'],
  ]) {
    const existing = docker(args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (existing.stdout.trim()) throw new InstallationError('An installed stack or its data already exists. Use its original installation directory; preparation will not replace it.');
  }
  const password = randomBytes(24).toString('base64url');
  const ownerId = `user_${randomUUID()}`;
  const secrets = Object.fromEntries(['database', 'review', 'media', 'credentials', 'lookup', 'deletion', 'storage', 'webhook'].map(name => [name, randomSecret()]));
  const base = docker(['compose', '--env-file', '/dev/null', '-f', resolve(root, 'docker-compose.yml'), '--profile', 'app', '--profile', 'malware-scan', 'config', '--format', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}), REVIEW_LINK_SECRET: secrets.review, MEDIA_DELIVERY_SECRET: secrets.media, S3_SECRET_KEY: secrets.storage },
  });
  await mkdir(privateDirectory, { mode: 0o700 });
  await mkdir(resolve(privateDirectory, 'key'), { mode: 0o700 });
  await mkdir(resolve(privateDirectory, 'settings'), { mode: 0o700 });
  await privateWrite(resolve(privateDirectory, 'key/master.key'), randomSecret());
  const hostUid = process.getuid?.() ?? 1000;
  const uid = hostUid === 0 ? 1000 : hostUid;
  const gid = hostUid === 0 ? 1000 : (process.getgid?.() ?? 1000);
  if (hostUid === 0) {
    for (const name of ['key', 'key/master.key', 'settings']) await chown(resolve(privateDirectory, name), uid, gid);
  }
  const compose = installationCompose(JSON.parse(base.stdout), { directory: privateDirectory, ownerId, password, secrets, uid, gid });
  await privateWrite(composeFile, JSON.stringify(compose, null, 2));
  await privateWrite(manifestFile, JSON.stringify({ version: 1, ownerId, workspaceId: 'default' }, null, 2));
  await privateWrite(resolve(privateDirectory, 'first-login.txt'), `Sign in at http://127.0.0.1:3100/setup\nEmail: installer@originpost.local\nPassword: ${password}\nKeep this file private. Change the password in the application after signing in.\n`);
  console.log('Installation prepared. No existing services or configuration were changed.');
  console.log('First sign-in details are in the protected .originpost-install/first-login.txt file.');
  console.log('Run node scripts/install.mjs start, then open http://127.0.0.1:3100/setup.');
}

async function run(command) {
  if (command === 'prepare') return prepare();
  if (!['start', 'apply', 'status'].includes(command)) throw new InstallationError('Usage: node scripts/install.mjs prepare|start|apply|status');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.version !== 1 || !manifest.ownerId) throw new InstallationError('Installation metadata is invalid.');
  const args = ['compose', '--env-file', '/dev/null', '-f', composeFile];
  if (command === 'status') { docker([...args, 'ps'], { stdio: 'inherit' }); return; }
  if (command === 'apply') {
    // Stop both consumers before loading a new configuration revision. Existing worker shutdown drains jobs.
    docker([...args, 'stop', '-t', '120', 'worker', 'api'], { stdio: 'inherit' });
    docker([...args, 'up', '-d', '--no-build', 'api', 'worker'], { stdio: 'inherit' });
  } else {
    for (const service of ['api', 'web', 'worker']) docker([...args, 'build', service], { stdio: 'inherit' });
    docker([...args, 'up', '-d', '--no-build'], { stdio: 'inherit' });
  }
  console.log('Open http://127.0.0.1:3100/setup to check setup. Starting a service does not prove provider readiness.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv[2]).catch(error => {
    // Never print parsed configuration, command output or a secret-containing error.
    console.error(error instanceof InstallationError ? error.message : 'Installation step failed. Verify Docker is running and check the protected installation files. Existing files are never overwritten by prepare.');
    process.exitCode = 1;
  });
}
