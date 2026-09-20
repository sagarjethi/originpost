import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadInstallationSettings, readInstallationSettings } from '@originpost/db';
import { ChannelOAuthService } from '../src/channels/channel-oauth.service.js';
import { CredentialVaultService } from '../src/channels/credential-vault.service.js';
import type { OriginPostInfrastructure } from '../src/infrastructure/infrastructure.types.js';
import { InstallationService } from '../src/installation/installation.service.js';
import type { AuthenticatedRequest } from '../src/common/auth-context.guard.js';

describe('installation settings security and startup application',()=>{
  let directory:string; let env:Record<string,string>; let service:InstallationService;
  const owner=()=>({originpostUserId:'installer',originpostActor:{id:'installer',name:'Installer',role:'owner'},originpostWorkspaceId:'installation',ip:'127.0.0.1'} as AuthenticatedRequest);
  beforeEach(()=>{
    directory=mkdtempSync(join(tmpdir(),'originpost-installation-test-'));
    const keyFile=join(directory,'master.key');writeFileSync(keyFile,Buffer.alloc(32,7).toString('hex'),{mode:0o600});
    env={NODE_ENV:'test',AUTH_MODE:'sessions',BOOTSTRAP_ADMIN_EMAIL:'installer@example.test',BOOTSTRAP_ADMIN_PASSWORD:'fixture-password-only',INSTALLATION_KEY_FILE:keyFile,INSTALLATION_SETTINGS_PATH:join(directory,'settings.enc'),INSTALLATION_OWNER_ID:'installer',INSTALLATION_WORKSPACE_ID:'installation',ADMIN_ALLOWED_IPS:'127.0.0.1',CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64'),IMAGE_GENERATION_MODE:'disabled',MEDIA_MALWARE_SCAN_MODE:'disabled',META_APP_ID:'',META_APP_SECRET:'',GOOGLE_CLIENT_ID:'',ALLOW_LIVE_PUBLISH:'false',INSTAGRAM_CONNECTOR_MODE:'mock',FACEBOOK_CONNECTOR_MODE:'mock',YOUTUBE_CONNECTOR_MODE:'mock',HERMES_BOARD_PLUGIN_ENABLED:'false'};
    for(const [key,value] of Object.entries(env))vi.stubEnv(key,value);
    service=new InstallationService(new ConfigService(env));
  });
  afterEach(()=>{vi.unstubAllEnvs();rmSync(directory,{recursive:true,force:true});});
  it('encrypts keys, redacts all responses, retains blank secrets and applies only after startup reload',()=>{
    const result=service.save(owner(),{version:0,values:{OPENAI_IMAGE_API_KEY:'fixture-image-provider-value',IMAGE_GENERATION_MODE:'openai',OPENAI_IMAGE_MODEL:'gpt-image-1',API_PUBLIC_URL:'https://api.example.test'}});
    expect(JSON.stringify(result)).not.toContain('fixture-image-provider-value');
    expect(result.secrets.OPENAI_IMAGE_API_KEY).toBe(true);expect(result.activeSecrets.OPENAI_IMAGE_API_KEY).toBe(false);expect(result.restartRequired).toBe(true);
    expect(readFileSync(env.INSTALLATION_SETTINGS_PATH!,'utf8')).not.toContain('fixture-image-provider-value');
    service.save(owner(),{version:1,values:{OPENAI_IMAGE_API_KEY:''}});
    const fresh={...env};loadInstallationSettings(fresh);
    expect(fresh.OPENAI_IMAGE_API_KEY).toBe('fixture-image-provider-value');expect(fresh.IMAGE_GENERATION_MODE).toBe('openai');
    const restarted=new InstallationService(new ConfigService(fresh));expect(restarted.get(owner()).restartRequired).toBe(false);
    expect(restarted.get(owner()).callbacks.instagram).toBe('https://api.example.test/v1/channels/oauth/instagram/callback');
  });
  it('denies other owners, workspaces, creators, missing principals and disallowed networks',()=>{
    for(const patch of [{originpostUserId:'other'},{originpostWorkspaceId:'other'},{originpostActor:{id:'installer',name:'Creator',role:'creator'}},{originpostActor:undefined},{ip:'192.0.2.1'}]) {
      const actor={...owner(),...patch} as AuthenticatedRequest;expect(()=>service.get(actor)).toThrow('installation owner');expect(()=>service.save(actor,{version:0,values:{}})).toThrow('installation owner');
    }
    expect(()=>new InstallationService(new ConfigService({...env,AUTH_MODE:'single-user'})).get(owner())).toThrow('installation owner');
  });
  it('rejects unsafe fields and invalid configurations without persisting them',()=>{
    for(const values of [{AUTH_MODE:'single-user'},{AUTH_COOKIE_SECURE:'false'},{FACEBOOK_CONNECTOR_MODE:'official'},{API_PUBLIC_URL:'http://example.test'},{API_PUBLIC_URL:'https://example.test/private'},{IMAGE_GENERATION_MODE:'openai'},{ALLOW_LIVE_PUBLISH:'true'},{META_APP_ID:'123'}])expect(()=>service.save(owner(),{version:0,values})).toThrow();
    expect(service.get(owner()).version).toBe(0);
  });
  it('makes saved OAuth credentials available to the real OAuth consumer after restart',()=>{
    vi.stubEnv('PROVIDER_LOOKUP_HMAC_KEYS',`v1:${Buffer.alloc(32,9).toString('hex')}`);
    vi.stubEnv('PROVIDER_LOOKUP_HMAC_ACTIVE_VERSION','v1');
    service.save(owner(),{version:0,values:{GOOGLE_CLIENT_ID:'fixture-client.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'fixture-oauth-secret'}});
    const fresh={...env};loadInstallationSettings(fresh);const config=new ConfigService(fresh);
    const infrastructure={} as OriginPostInfrastructure;
    const oauth=new ChannelOAuthService(infrastructure,config,new CredentialVaultService(config,infrastructure));
    expect(oauth.youtubeConfigured()).toBe(true);
    expect(JSON.stringify(service.get(owner()))).not.toContain('fixture-oauth-secret');
  });
  it('accepts local loopback addresses but rejects public HTTP',()=>{
    for (const address of ['http://localhost:3310','http://127.0.0.1:4310','http://[::1]:5310']) {
      const result=service.save(owner(),{version:service.get(owner()).version,values:{WEB_PUBLIC_URL:address,API_PUBLIC_URL:address,CORS_ORIGIN:address,S3_PUBLIC_ENDPOINT:address}});
      expect(result.values.WEB_PUBLIC_URL).toBe(address);expect(result.values.AUTH_COOKIE_SECURE).toBe('false');
    }
    expect(()=>service.save(owner(),{version:3,values:{API_PUBLIC_URL:'http://192.0.2.1:4310'}})).toThrow();
  });
  it('removes secrets explicitly, respects provider dependencies and keeps version checks',()=>{
    service.save(owner(),{version:0,values:{OPENAI_IMAGE_API_KEY:'fixture-removable-image-key',IMAGE_GENERATION_MODE:'openai'}});
    expect(()=>service.save(owner(),{version:1,values:{},clearSecrets:['OPENAI_IMAGE_API_KEY']})).toThrow('Disable image generation');
    expect(()=>service.save(owner(),{version:1,values:{},clearSecrets:['CREDENTIAL_ENCRYPTION_KEY']})).toThrow('Only provider secrets');
    const result=service.save(owner(),{version:1,values:{IMAGE_GENERATION_MODE:'disabled'},clearSecrets:['OPENAI_IMAGE_API_KEY']});
    expect(result.secrets.OPENAI_IMAGE_API_KEY).toBe(false);
    const fresh={...env,OPENAI_IMAGE_API_KEY:'fixture-old-environment-value'};loadInstallationSettings(fresh);expect(fresh.OPENAI_IMAGE_API_KEY).toBe('');
  });
  it('does not advertise shared Meta credentials as direct Instagram Login in managed installation',async()=>{
    const config=new ConfigService({...env,META_APP_ID:'fixture-meta-id',META_APP_SECRET:'fixture-meta-secret',META_GRAPH_API_VERSION:'v24.0'});
    const infrastructure={} as OriginPostInfrastructure;const oauth=new ChannelOAuthService(infrastructure,config,new CredentialVaultService(config,infrastructure));
    expect(oauth.configured()).toBe(false);expect(oauth.facebookConfigured()).toBe(true);expect(oauth.instagramFacebookConfigured()).toBe(true);
    await expect(oauth.startInstagram('installation',undefined,owner().originpostActor!)).rejects.toThrow('Facebook Login');
    await expect(oauth.callbackInstagram({state:'fixture-state',code:'fixture-code'})).rejects.toThrow('Facebook Login');
  });
  it('forces secure cookies for a public HTTPS site',()=>{
    const result=service.save(owner(),{version:0,values:{WEB_PUBLIC_URL:'https://app.example.test'}});
    expect(result.values.AUTH_COOKIE_SECURE).toBe('true');
    const fresh={...env,AUTH_COOKIE_SECURE:'false'};loadInstallationSettings(fresh);expect(fresh.AUTH_COOKIE_SECURE).toBe('true');
  });
  it('rejects stale writes and authenticated ciphertext moved to another deployment scope',()=>{
    service.save(owner(),{version:0,values:{API_PUBLIC_URL:'https://api.example.test'}});
    expect(()=>service.save(owner(),{version:0,values:{API_PUBLIC_URL:'https://other.example.test'}})).toThrow('changed');
    expect(()=>readInstallationSettings({path:env.INSTALLATION_SETTINGS_PATH!,keyFile:env.INSTALLATION_KEY_FILE!,ownerId:'different',workspaceId:'installation'})).toThrow();
    expect(service.get(owner()).values.API_PUBLIC_URL).toBe('https://api.example.test');
  });
});
