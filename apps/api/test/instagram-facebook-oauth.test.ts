import { ConfigService } from "@nestjs/config";
import { InMemoryConnectedAccountRepository, InMemoryOAuthRepository } from "@originpost/domain";
import { InstagramOfficialConnector } from "@originpost/connectors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelOAuthService } from "../src/channels/channel-oauth.service.js";
import { CredentialVaultService } from "../src/channels/credential-vault.service.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
import { resolveInstagramFacebookPublishingCredential } from "../src/channels/instagram-facebook-credential.js";

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});

describe("Instagram Facebook Login provider transport",()=>{
  afterEach(()=>vi.unstubAllGlobals());

  it("pins every provider call and never puts codes, tokens, or app secrets in URLs",async()=>{
    const oauthRepository=new InMemoryOAuthRepository();const connectedAccountRepository=new InMemoryConnectedAccountRepository(oauthRepository);
    const infrastructure={oauthRepository,connectedAccountRepository,organizationRepository:{listBrands:vi.fn(async()=>[{id:"brand-1",workspaceId:"default",name:"Brand",slug:"brand",primaryLanguage:"English",timezone:"UTC",status:"active",createdBy:"owner",createdAt:"2026-08-29T00:00:00.000Z",updatedAt:"2026-08-29T00:00:00.000Z"}])},authRepository:{}} as unknown as OriginPostInfrastructure;
    const verifiedAt=new Date(Date.now()-60_000).toISOString();const expiresAt=new Date(Date.now()+60_000).toISOString();
    const config=new ConfigService({NODE_ENV:"development",AUTH_MODE:"single-user",META_APP_ID:"meta-app-123",META_APP_SECRET:"meta-app-secret-never-in-url",META_GRAPH_API_VERSION:"v26.0",CREDENTIAL_ENCRYPTION_KEY:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",PROVIDER_LOOKUP_HMAC_KEYS:`v1:${Buffer.alloc(32,7).toString("base64")}`,PROVIDER_LOOKUP_HMAC_ACTIVE_VERSION:"v1",API_PUBLIC_URL:"https://api.example.test",WEB_PUBLIC_URL:"https://app.example.test",INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_API_VERSION:"v26.0",INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_VERIFIED_AT:verifiedAt,INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_EXPIRES_AT:expiresAt});
    const responses=[json({access_token:"short-token-never-in-url"}),json({data:{is_valid:true,app_id:"meta-app-123",user_id:"100000000000001"}}),json({access_token:"long-token-never-in-url"}),json({data:["instagram_basic","instagram_content_publish","instagram_manage_comments","instagram_manage_contents","instagram_manage_insights","pages_read_engagement","pages_show_list"].map((permission)=>({permission,status:"granted"}))}),json({data:[{id:"page-1",name:"Page One",access_token:"page-token-never-in-url",tasks:["CREATE_CONTENT"],instagram_business_account:{id:"ig-1",username:"Publisher.Name"}}]})];
    const transport=vi.fn(async()=>responses.shift()!);vi.stubGlobal("fetch",transport);
    const vault=new CredentialVaultService(config,infrastructure);const service=new ChannelOAuthService(infrastructure,config,vault);const actor={id:"owner",name:"Owner",role:"owner" as const};
    const started=await service.startInstagramFacebook("default",undefined,actor);const state=new URL(started.authorizationUrl).searchParams.get("state")!;const callback=await service.callbackInstagramFacebook({state,code:"authorization-code-never-in-url"});expect(callback.connected).toBe(false);
    expect(transport).toHaveBeenCalledTimes(5);
    for(const [input] of transport.mock.calls){const url=String(input);expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v26\.0\//);expect(url).not.toMatch(/authorization-code-never-in-url|short-token-never-in-url|long-token-never-in-url|page-token-never-in-url|meta-app-secret-never-in-url/i);const parsed=new URL(url);expect(parsed.searchParams.has("access_token")).toBe(false);expect(parsed.searchParams.has("client_secret")).toBe(false);expect(parsed.searchParams.has("input_token")).toBe(false);}
    const redirect=new URL(callback.redirectUrl);const selectionId=redirect.searchParams.get("selectionId")!;const selection=await service.getInstagramFacebookSelection("default",selectionId,actor);expect(selection.accounts).toEqual([{externalAccountId:"ig-1",username:"publisher.name",displayName:"@publisher.name",pageId:"page-1",pageName:"Page One"}]);expect(JSON.stringify(selection)).not.toContain("token");
    const completed=await service.completeInstagramFacebookSelection("default",selectionId,["ig-1"],actor);const accountId=completed.accounts[0]!.id;const account=(await connectedAccountRepository.get("default",accountId))!;const stored=JSON.parse(await vault.open("default",account.credentialRef!.slice(7))) as Record<string,unknown>;
    const runtime={appId:"meta-app-123",providerVersion:"v26.0",callbackUrl:"https://api.example.test/v1/channels/oauth/instagram-facebook/callback",probe:{state:"verified" as const,apiVersion:"v26.0"}};const credential=resolveInstagramFacebookPublishingCredential(stored,account,runtime);const connector=new InstagramOfficialConnector({apiVersion:"v26.0",resolveCredential:async()=>credential});
    expect(credential.accountType).toBe("BUSINESS");
    await expect(connector.getCollaboratorCapability({workspaceId:"default",accountId})).resolves.toMatchObject({state:"supported",connectionMode:"facebook_login"});
    expect(()=>resolveInstagramFacebookPublishingCredential({...stored,pageId:"page-rebound"},account,runtime)).toThrow("binding is stale");
    expect(()=>resolveInstagramFacebookPublishingCredential({...stored,providerVersion:"v25.0"},account,runtime)).toThrow("binding is stale");
    expect(()=>resolveInstagramFacebookPublishingCredential(stored,{...account,updatedAt:new Date(Date.now()+1_000).toISOString()},runtime)).toThrow("binding is stale");
  });
});
