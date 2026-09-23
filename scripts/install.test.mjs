import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { installationCompose, installationStatus } from './install.mjs';

const base = {
  name: 'originpost', services: Object.fromEntries(['api','worker','web','postgres','minio','redis','clamav'].map(name => [name, {environment:{}, profiles:['app'],ports:['3000:3000']}])),
  volumes: { 'originpost-postgres': {name:'originpost_originpost-postgres'} }, networks: { default: {name:'originpost_default'} },
};
const options = { directory:'/private-install', ownerId:'user_test-owner', password:'test-only-generated-password', secrets:Object.fromEntries(['database','review','media','credentials','lookup','deletion','storage','webhook'].map(name=>[name,`test-only-${name}`])) };
test('fresh installation isolates data, requires sessions and grants settings writes only to API', () => {
  const actual = installationCompose(base, options);
  assert.equal(actual.name, 'originpost-installed');
  assert.equal(actual.volumes['originpost-postgres'].name, undefined);
  assert.equal(actual.networks.default.name, undefined);
  assert.equal(actual.services.api.environment.AUTH_MODE, 'sessions');
  assert.equal(actual.services.api.environment.INSTALLATION_OWNER_ID, options.ownerId);
  assert.equal(actual.services.api.environment.ALLOW_LIVE_PUBLISH, 'false');
  assert.equal(actual.services.api.environment.META_WEBHOOK_VERIFY_TOKEN, 'test-only-webhook');
  assert.equal(actual.services.api.environment.MEDIA_MALWARE_SCAN_MODE, 'clamav');
  assert.equal(actual.services.api.volumes[1].read_only, false);
  assert.equal(actual.services.worker.volumes[1].read_only, true);
  assert.equal(actual.services.api.volumes[0].read_only, true);
  assert.equal(actual.services.worker.volumes[0].read_only, true);
  assert.equal(actual.services.postgres.ports, undefined);
  assert.equal(actual.services.redis.ports, undefined);
  assert.deepEqual(actual.services.web.ports,['127.0.0.1:3100:3000']);
  assert.deepEqual(actual.services.worker.command,['node','apps/worker/dist/main.js']);
  assert.equal(actual.services.api.environment.DATABASE_URL,'postgres://originpost:test-only-database@postgres:5432/originpost');
  assert.equal(base.volumes['originpost-postgres'].name, 'originpost_originpost-postgres');
});
test('browser sandbox profile resolves from the checkout, not the private Compose directory', () => {
  const configured = structuredClone(base);
  configured.services.worker.security_opt = ['seccomp=./deploy/browser-seccomp.json', 'no-new-privileges:true'];
  const actual = installationCompose(configured, options);
  assert.deepEqual(actual.services.worker.security_opt, [
    `seccomp=${fileURLToPath(new URL('../deploy/browser-seccomp.json', import.meta.url))}`,
    'no-new-privileges:true',
  ]);
});

const runningDocker = () => ({ status: 0, stdout: 'NAMES  STATUS\noriginpost-installed-api-1  Up 3 minutes' });
const healthyResponse = async () => Response.json({ status: 'ok', service: 'originpost-api' });

async function healthServer(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/health`;
}

test('status checks the actual API using only a bounded read-only request', async t => {
  const lines = [];
  const apiHealthUrl = await healthServer(t, (request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/health');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', service: 'originpost-api' }));
  });
  await installationStatus({ apiHealthUrl, output: line => lines.push(line), runCommand: (command, args, options) => {
    assert.equal(command, 'docker');
    assert.deepEqual(args.slice(0, 4), ['ps', '--all', '--filter', 'label=com.docker.compose.project=originpost-installed']);
    assert.equal(options.timeout, 10_000);
    assert.equal(options.killSignal, 'SIGKILL');
    return runningDocker();
  } });
  assert.match(lines.at(-1), /API health: reachable.*does not verify worker/);
});

test('a running container with an empty API reply fails status', async t => {
  const lines = [];
  const apiHealthUrl = await healthServer(t, request => request.socket.destroy());
  await assert.rejects(installationStatus({ apiHealthUrl, runCommand: runningDocker, output: line => lines.push(line) }), /Installation is not ready/);
  assert.match(lines.at(-1), /API health: unavailable/);
});

test('wrong services and unhealthy HTTP responses do not pass readiness or leak response bodies', async () => {
  for (const response of [
    Response.json({ status: 'ok', service: 'different-service', private: 'private-response-marker' }),
    new Response('private-response-marker', { status: 503 }),
    new Response('private-response-marker', { status: 200 }),
  ]) {
    const lines = [];
    await assert.rejects(installationStatus({ runCommand: runningDocker, request: async () => response, output: line => lines.push(line) }), /Installation is not ready/);
    assert.doesNotMatch(lines.join('\n'), /private-response-marker/);
  }
});

test('a stalled API response body times out', async t => {
  const apiHealthUrl = await healthServer(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
  });
  await assert.rejects(installationStatus({ apiHealthUrl, runCommand: runningDocker, healthTimeoutMs: 50, output: () => {} }), /Installation is not ready/);
});

test('a stalled Docker status command is terminated while the API is still checked', async () => {
  let checkedApi = false;
  let timedOut = false;
  await assert.rejects(installationStatus({
    dockerTimeoutMs: 50,
    runCommand: (_command, _args, options) => {
      const result = spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
      timedOut = result.error?.code === 'ETIMEDOUT';
      return result;
    },
    request: async () => { checkedApi = true; return healthyResponse(); },
    output: () => {},
  }), /Installation is not ready/);
  assert.equal(timedOut, true);
  assert.equal(checkedApi, true);
});

test('failed Docker status suppresses command stderr and transport error details', async () => {
  const lines = [];
  await assert.rejects(installationStatus({
    runCommand: () => ({ status: 1, stderr: 'private-command-marker', stdout: 'private-command-marker' }),
    request: async () => { throw new Error('private-transport-marker'); },
    output: line => lines.push(line),
  }), /Installation is not ready/);
  assert.doesNotMatch(lines.join('\n'), /private-command-marker|private-transport-marker/);
});
