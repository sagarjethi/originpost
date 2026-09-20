import test from 'node:test';
import assert from 'node:assert/strict';
import { installationCompose } from './install.mjs';

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
