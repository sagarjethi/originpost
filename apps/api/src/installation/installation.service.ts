import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { installationSecretKeys, installationSettingKeys, InstallationVersionConflict, readInstallationSettings, writeInstallationSettings, type InstallationStoreOptions } from '@originpost/db';
import type { AuthenticatedRequest } from '../common/auth-context.guard.js';
import { adminNetworkAllowed } from '../common/admin-network.js';
import { validateConfig } from '../configuration.js';

@Injectable()
export class InstallationService {
  constructor(private readonly config: ConfigService) {}
  private options(request: AuthenticatedRequest): InstallationStoreOptions {
    const ownerId = this.config.get<string>('INSTALLATION_OWNER_ID');
    const workspaceId = this.config.get<string>('INSTALLATION_WORKSPACE_ID');
    const path = this.config.get<string>('INSTALLATION_SETTINGS_PATH');
    const keyFile = this.config.get<string>('INSTALLATION_KEY_FILE');
    if (this.config.get('AUTH_MODE') !== 'sessions' || !ownerId || !workspaceId || !path || !keyFile || request.originpostUserId !== ownerId || request.originpostActor?.id !== ownerId || request.originpostActor.role !== 'owner' || request.originpostWorkspaceId !== workspaceId || !adminNetworkAllowed(this.config.get('ADMIN_ALLOWED_IPS'),request.ip)) {
      throw new ForbiddenException('Sign in as the installation owner in the installation workspace from an approved administrator network. Guided installation must be enabled by the server installer.');
    }
    return {ownerId,workspaceId,path,keyFile};
  }
  private currentValues(): Record<string,string> {
    return Object.fromEntries(installationSettingKeys.flatMap(name=> {const value=this.config.get(name);return value===undefined?[]:[[name,String(value)]];}));
  }
  private publicValues(values: Record<string,string>) { return Object.fromEntries(Object.entries(values).filter(([name])=>!(installationSecretKeys as readonly string[]).includes(name))); }
  private secrets(values: Record<string,string>) { return Object.fromEntries(installationSecretKeys.map(name=>[name,Boolean(values[name])])); }
  get(request: AuthenticatedRequest) {
    const stored = readInstallationSettings(this.options(request));
    const active = this.currentValues(); const desired = {...active,...stored.values};
    const api = (desired.API_PUBLIC_URL ?? '').replace(/\/$/,'');
    return {version:stored.version,restartRequired:stored.version !== Number(this.config.get('INSTALLATION_ACTIVE_VERSION') ?? 0),values:this.publicValues(desired),secrets:this.secrets(desired),activeValues:this.publicValues(active),activeSecrets:this.secrets(active),checks:{sessions:true,encryption:Boolean(this.config.get('CREDENTIAL_ENCRYPTION_KEY')),networkRestricted:Boolean(this.config.get<string>('ADMIN_ALLOWED_IPS')?.trim())},callbacks:{instagram:`${api}/v1/channels/oauth/instagram/callback`,facebook:`${api}/v1/channels/oauth/facebook/callback`,instagramFacebook:`${api}/v1/channels/oauth/instagram-facebook/callback`,youtube:`${api}/v1/channels/oauth/youtube/callback`}};
  }
  save(request: AuthenticatedRequest, input: {version:number;values:Record<string,string>;clearSecrets?:string[]}) {
    const options = this.options(request);
    if (!Number.isSafeInteger(input?.version) || input.version<0 || !input.values || typeof input.values !== 'object' || Array.isArray(input.values) || Object.keys(input).some(name=>!['version','values','clearSecrets'].includes(name))) throw new BadRequestException('Provide a settings version and configuration fields.');
    if (input.clearSecrets !== undefined && (!Array.isArray(input.clearSecrets) || input.clearSecrets.some(name=>!(installationSecretKeys as readonly string[]).includes(name)))) throw new BadRequestException('Only provider secrets can be removed.');
    const patch: Record<string,string> = {};
    for (const [name,raw] of Object.entries(input.values)) {
      if (name === 'AUTH_COOKIE_SECURE' || !(installationSettingKeys as readonly string[]).includes(name) || typeof raw !== 'string' || raw.length>4096 || /[\r\n\0]/u.test(raw)) throw new BadRequestException('An unsupported or invalid configuration field was supplied.');
      const value=raw.trim();
      if ((installationSecretKeys as readonly string[]).includes(name) && !value) continue;
      if (['WEB_PUBLIC_URL','API_PUBLIC_URL','S3_PUBLIC_ENDPOINT','CORS_ORIGIN'].includes(name)) {
        let url: URL; try { url=new URL(value); } catch { throw new BadRequestException('Public addresses must be HTTPS origins.'); }
        const localHttp=url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
        if((url.protocol!=='https:'&&!localHttp)||url.username||url.password||url.search||url.hash||url.pathname!=='/') throw new BadRequestException('Use an HTTPS origin or local loopback HTTP address without a path.');
      }
      if (name==='META_GRAPH_API_VERSION' && !/^v\d+\.\d+$/.test(value)) throw new BadRequestException('Meta API version must use vNN.N format.');
      if (name==='ALLOW_LIVE_PUBLISH' && !['true','false'].includes(value)) throw new BadRequestException('Publishing must be enabled or disabled explicitly.');
      patch[name]=value;
    }
    for (const name of input.clearSecrets ?? []) {
      if (patch[name]) throw new BadRequestException('A secret cannot be replaced and removed in the same request.');
      patch[name]='';
    }
    const previous=readInstallationSettings(options);
    const values={...previous.values,...patch};
    if (patch.WEB_PUBLIC_URL) values.AUTH_COOKIE_SECURE=patch.WEB_PUBLIC_URL.startsWith('https://')?'true':'false';
    // Validate against all deployment safeguards, including sessions, malware scanning and provider contracts.
    const base={...process.env};
    for (const name of Object.keys(base)) { const value=this.config.get(name); if(value!==undefined) base[name]=String(value); }
    Object.assign(base,this.currentValues(),values);
    const official = [base.INSTAGRAM_CONNECTOR_MODE,base.FACEBOOK_CONNECTOR_MODE,base.YOUTUBE_CONNECTOR_MODE].some(mode=>mode==='official');
    if (official !== (base.ALLOW_LIVE_PUBLISH==='true')) throw new BadRequestException('Enable live publishing and at least one official publishing connector together, or disable both.');
    if (base.GOOGLE_CLIENT_ID && !base.GOOGLE_CLIENT_SECRET) throw new BadRequestException('Remove the Google client ID together with its secret.');
    if ((input.clearSecrets ?? []).includes('OPENAI_IMAGE_API_KEY') && base.IMAGE_GENERATION_MODE==='openai') throw new BadRequestException('Disable image generation before removing its key.');
    try { validateConfig(base); } catch (error) { throw new BadRequestException(error instanceof Error?error.message:'The settings do not satisfy deployment requirements.'); }
    try { writeInstallationSettings(options,input.version,values); } catch (error) {
      if(error instanceof InstallationVersionConflict) throw new ConflictException(error.message);
      throw new ConflictException('The protected installation settings could not be saved. Check server storage permissions.');
    }
    return this.get(request);
  }
}
