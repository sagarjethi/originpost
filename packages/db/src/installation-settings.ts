import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const installationSettingKeys = ['WEB_PUBLIC_URL','API_PUBLIC_URL','S3_PUBLIC_ENDPOINT','AUTH_COOKIE_SECURE','CORS_ORIGIN','META_APP_ID','META_APP_SECRET','META_WEBHOOK_VERIFY_TOKEN','META_GRAPH_API_VERSION','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','IMAGE_GENERATION_MODE','OPENAI_IMAGE_MODEL','OPENAI_IMAGE_API_KEY','INSTAGRAM_CONNECTOR_MODE','FACEBOOK_CONNECTOR_MODE','YOUTUBE_CONNECTOR_MODE','ALLOW_LIVE_PUBLISH'] as const;
export const installationSecretKeys = ['META_APP_SECRET','META_WEBHOOK_VERIFY_TOKEN','GOOGLE_CLIENT_SECRET','OPENAI_IMAGE_API_KEY'] as const;
export interface InstallationSettings { version: number; values: Record<string,string> }
export interface InstallationStoreOptions { path: string; keyFile: string; ownerId: string; workspaceId: string }
export class InstallationVersionConflict extends Error {}
function key(options: InstallationStoreOptions): Buffer {
  if (!options.ownerId || !options.workspaceId) throw new Error('Installation administrator scope is missing.');
  if ((statSync(options.keyFile).mode & 0o077) !== 0) throw new Error('Installation key file must be private.');
  const raw = readFileSync(options.keyFile,'utf8').trim();
  const result = Buffer.from(raw, /^[a-f0-9]{64}$/i.test(raw) ? 'hex' : 'base64');
  if (result.length !== 32) throw new Error('Installation encryption key is invalid.');
  return result;
}
function aad(options: InstallationStoreOptions) { return Buffer.from(JSON.stringify(['originpost-installation',1,options.ownerId,options.workspaceId])); }
export function readInstallationSettings(options: InstallationStoreOptions): InstallationSettings {
  const secret = key(options);
  if (!existsSync(options.path)) return {version:0,values:{}};
  const envelope = JSON.parse(readFileSync(options.path,'utf8')) as {iv:string;tag:string;ciphertext:string};
  const decipher = createDecipheriv('aes-256-gcm',secret,Buffer.from(envelope.iv,'base64'));
  decipher.setAAD(aad(options)); decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  const record = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8')) as InstallationSettings;
  if (!Number.isSafeInteger(record.version) || record.version < 1 || !record.values || Object.entries(record.values).some(([name,value])=>!(installationSettingKeys as readonly string[]).includes(name)||typeof value!=='string')) throw new Error('Installation settings are invalid.');
  return record;
}
export function writeInstallationSettings(options: InstallationStoreOptions, expectedVersion: number, values: Record<string,string>): InstallationSettings {
  mkdirSync(dirname(options.path),{recursive:true,mode:0o700});
  const lock = `${options.path}.lock`;
  try { mkdirSync(lock,{mode:0o700}); } catch { throw new InstallationVersionConflict('Installation settings are busy. Reload and try again.'); }
  const temporary = `${options.path}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    const current = readInstallationSettings(options);
    if (current.version !== expectedVersion) throw new InstallationVersionConflict('Installation settings changed. Reload and try again.');
    if (Object.entries(values).some(([name,value])=>!(installationSettingKeys as readonly string[]).includes(name)||typeof value!=='string')) throw new Error('Unsupported installation setting.');
    const record = {version:current.version+1,values};
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm',key(options),iv); cipher.setAAD(aad(options));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record),'utf8'),cipher.final()]);
    writeFileSync(temporary,JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}),{mode:0o600,flag:'wx'});
    const fd = openSync(temporary,'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary,options.path);
    return record;
  } finally { rmSync(temporary,{force:true}); rmSync(lock,{recursive:true,force:true}); }
}
/** Run once before importing API/worker modules. Existing constructors keep a consistent startup snapshot. */
export function loadInstallationSettings(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.INSTALLATION_SETTINGS_PATH) return;
  if (!env.INSTALLATION_KEY_FILE || !env.INSTALLATION_OWNER_ID || !env.INSTALLATION_WORKSPACE_ID) throw new Error('Installation configuration is incomplete.');
  const settings = readInstallationSettings({path:env.INSTALLATION_SETTINGS_PATH,keyFile:env.INSTALLATION_KEY_FILE,ownerId:env.INSTALLATION_OWNER_ID,workspaceId:env.INSTALLATION_WORKSPACE_ID});
  Object.assign(env,settings.values,{INSTALLATION_ACTIVE_VERSION:String(settings.version)});
}
