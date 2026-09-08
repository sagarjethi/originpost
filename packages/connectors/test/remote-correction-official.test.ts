import { describe, expect, it, vi } from "vitest";
import { advanceRemoteCorrectionOperation, approveRemoteCorrectionRequest, canonicalSha256, createRemoteCorrectionRequest, type PublishProof, type RemoteCorrectionMutation } from "@originpost/domain";
import { FacebookPageOfficialConnector, InstagramOfficialConnector, YouTubeOfficialConnector, type RemoteContentSnapshot, type RemoteCorrectionConnector, type RemoteCorrectionTarget } from "../src/index.js";

const sha = (value: string) => canonicalSha256(value);
const response = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function proof(platform: "instagram" | "facebook" | "youtube", externalPostId: string): PublishProof {
  return {
    id: `proof-${platform}`, contentItemId: "content-1", draftId: "draft-1", draftSha256: sha("draft"), platform,
    accountId: `account-${platform}`, externalPostId, liveUrl: "https://example.invalid/live", publishedAt: "2026-08-29T10:00:00.000Z",
    captionSha256: sha("caption"), mediaSha256: [sha("media")], connectorResponseSha256: sha("publish"), approvedBy: "editor-1",
    sourceIds: ["source-1"], disclosure: "none",
  };
}

async function correction(connector: RemoteCorrectionConnector, published: PublishProof, mutation: RemoteCorrectionMutation) {
  const target: RemoteCorrectionTarget = {
    workspaceId: "workspace-1", brandId: "brand-1", publishProofId: published.id, contentItemId: published.contentItemId,
    draftId: published.draftId, draftSha256: published.draftSha256, platform: published.platform, accountId: published.accountId,
    externalPostId: published.externalPostId, mutation,
  };
  const before = await connector.preflightCorrection(target);
  const requested = createRemoteCorrectionRequest({
    id: `operation-${published.platform}`, workspaceId: target.workspaceId, brandId: target.brandId, publishProof: published, mutation,
    reason: "The live publication requires correction.", requestedBy: "manager-1", requestedAt: "2026-08-29T10:01:00.000Z",
  });
  const approved = approveRemoteCorrectionRequest({operation:requested,approval:{actorId:"owner-1",actorType:"human",approvedAt:"2026-08-29T10:02:00.000Z"},beforeSnapshot:before});
  const preWrite = advanceRemoteCorrectionOperation(approved, "pre_write", "2026-08-29T10:03:00.000Z");
  return { before, operation: advanceRemoteCorrectionOperation(preWrite, "finalizing", "2026-08-29T10:04:00.000Z") };
}

describe("official remote correction adapters", () => {
  it("deletes the exact Instagram carousel container only with Facebook Login/manage-contents and verifies absence", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(response({ id: "carousel-1", media_type: "CAROUSEL_ALBUM", media_product_type: "FEED", owner: { id: "ig-1" } }))
      .mockResolvedValueOnce(response({ success: true, deleted_id: "carousel-1" }))
      .mockResolvedValueOnce(response({}, 404));
    const connector = new InstagramOfficialConnector({
      apiVersion: "v26.0", baseUrl: "https://graph.instagram.test", facebookGraphBaseUrl: "https://graph.facebook.test", fetch: transport,
      resolveCredential: async () => ({ externalAccountId: "ig-1", accessToken: "server-only-token", connectionMode: "facebook_login", scopes: ["instagram_basic", "instagram_manage_contents"] }),
    });
    const request = await correction(connector, proof("instagram", "carousel-1"), { action: "delete_remote" });
    expect(request.before.objectKind).toBe("carousel_container");
    await expect(connector.executeCorrection(request)).resolves.toMatchObject({ kind: "provider_confirmed", after: { state: "not_found", externalPostId: "carousel-1" } });
    expect(transport.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE", headers: { authorization: "Bearer server-only-token" } });
    expect(String(transport.mock.calls[1]?.[0])).not.toContain("access_token");
  });

  it("does not treat ambiguous Instagram object errors or missing owner identity as removal proof", async () => {
    const ambiguous = new InstagramOfficialConnector({
      apiVersion:"v26.0",facebookGraphBaseUrl:"https://graph.facebook.test",fetch:vi.fn().mockResolvedValue(response({error:{code:100,error_subcode:2207007}},400)),
      resolveCredential:async()=>({externalAccountId:"ig-1",accessToken:"token",connectionMode:"facebook_login",scope:"instagram_basic instagram_manage_contents"}),
    });
    await expect(ambiguous.preflightCorrection({workspaceId:"workspace-1",brandId:"brand-1",publishProofId:"proof-instagram",contentItemId:"content-1",draftId:"draft-1",draftSha256:sha("draft"),platform:"instagram",accountId:"account-instagram",externalPostId:"media-1",mutation:{action:"delete_remote"}})).rejects.toMatchObject({code:"uncertain"});
    const missingOwner = new InstagramOfficialConnector({
      apiVersion:"v26.0",facebookGraphBaseUrl:"https://graph.facebook.test",fetch:vi.fn().mockResolvedValue(response({id:"media-1",media_type:"IMAGE",media_product_type:"FEED"})),
      resolveCredential:async()=>({externalAccountId:"ig-1",accessToken:"token",connectionMode:"facebook_login",scope:"instagram_basic instagram_manage_contents"}),
    });
    await expect(missingOwner.preflightCorrection({workspaceId:"workspace-1",brandId:"brand-1",publishProofId:"proof-instagram",contentItemId:"content-1",draftId:"draft-1",draftSha256:sha("draft"),platform:"instagram",accountId:"account-instagram",externalPostId:"media-1",mutation:{action:"delete_remote"}})).rejects.toMatchObject({code:"uncertain"});
  });

  it("fails Instagram deletion closed and never blindly retries an ambiguous write", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(response({ id: "media-1", media_type: "IMAGE", media_product_type: "FEED", owner: { id: "ig-1" } }))
      .mockRejectedValueOnce(new DOMException("Timed out", "AbortError"));
    const connector = new InstagramOfficialConnector({
      apiVersion: "v26.0", facebookGraphBaseUrl: "https://graph.facebook.test", fetch: transport,
      resolveCredential: async () => ({ externalAccountId: "ig-1", accessToken: "token", connectionMode: "facebook_login", scope: "instagram_basic instagram_manage_contents" }),
    });
    const request = await correction(connector, proof("instagram", "media-1"), { action: "delete_remote" });
    await expect(connector.executeCorrection(request)).resolves.toMatchObject({ kind: "uncertain" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("keeps Facebook deletion behind the exact live probe and hands off to Business Manager otherwise", async () => {
    const transport = vi.fn().mockResolvedValue(response({ id: "page-1_42", from: { id: "page-1" }, is_published: true, message: "Old" }));
    const connector = new FacebookPageOfficialConnector({
      apiVersion: "v26.0", appSecret: "app-secret", baseUrl: "https://graph.facebook.test", fetch: transport,
      resolveCredential: async () => ({ externalAccountId: "page-1", accessToken: "page-token", scopes: ["pages_manage_posts"] }),
    });
    await expect(connector.correctionCapabilities({ workspaceId: "workspace-1", accountId: "account-facebook", platform: "facebook" })).resolves.toMatchObject({ actions: { delete_remote: { state: "contract_probe_required" } } });
    const request = await correction(connector, proof("facebook", "page-1_42"), { action: "delete_remote" });
    await expect(connector.executeCorrection(request)).resolves.toMatchObject({ kind: "manual_action_required", handoff: "business_manager" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("uses Facebook bearer auth plus appsecret proof and verifies an allowlisted deletion", async () => {
    const pageTasksSha256=canonicalSha256({schemaVersion:"originpost.facebook-page-tasks.v1",tasks:["CREATE_CONTENT"]});
    const transport = vi.fn()
      .mockResolvedValueOnce(response({ id: "page-1_42", from: { id: "page-1" }, is_published: true }))
      .mockResolvedValueOnce(response({ id:"page-1",tasks:["CREATE_CONTENT"] }))
      .mockResolvedValueOnce(response({ success: true }))
      .mockResolvedValueOnce(response({ error: { code: 100, message: "Object does not exist" } }, 404));
    const connector = new FacebookPageOfficialConnector({
      apiVersion: "v26.0", appSecret: "app-secret", appId:"app-1",environment:"test", baseUrl: "https://graph.facebook.test", fetch: transport,
      pageDeleteContractProbe: { apiVersion: "v26.0", verifiedAt: "2026-08-29T06:00:00.000Z",expiresAt:"2026-09-10T06:00:00.000Z",environment:"test",appId:"app-1",accountId:"account-facebook",externalPageId:"page-1",credentialVersion:"credential-v1",accountVersion:"account-v1",pageTasksSha256,task:"page_post_delete" },
      resolveCredential: async () => ({ externalAccountId: "page-1", accessToken: "page-token", scope: "pages_manage_posts pages_read_engagement",pageTasks:["CREATE_CONTENT"],credentialVersion:"credential-v1",accountVersion:"account-v1" }),
    });
    const request = await correction(connector, proof("facebook", "page-1_42"), { action: "delete_remote" });
    await expect(connector.executeCorrection(request)).resolves.toMatchObject({ kind: "provider_confirmed", after: { state: "not_found" } });
    const deleteUrl = new URL(String(transport.mock.calls[2]?.[0]));
    expect(deleteUrl.searchParams.has("appsecret_proof")).toBe(true);
    expect(deleteUrl.searchParams.has("appsecret_time")).toBe(true);
    expect(deleteUrl.searchParams.has("access_token")).toBe(false);
    expect(transport.mock.calls[2]?.[1]).toMatchObject({ method: "DELETE", headers: { authorization: "Bearer page-token" } });
  });

  it("fails the Facebook delete probe closed after a Page rebind", async () => {
    const pageTasksSha256=canonicalSha256({schemaVersion:"originpost.facebook-page-tasks.v1",tasks:["CREATE_CONTENT"]});
    const connector=new FacebookPageOfficialConnector({apiVersion:"v26.0",appSecret:"app-secret",appId:"app-1",environment:"test",pageDeleteContractProbe:{apiVersion:"v26.0",verifiedAt:"2026-08-29T06:00:00.000Z",expiresAt:"2026-09-10T06:00:00.000Z",environment:"test",appId:"app-1",accountId:"account-facebook",externalPageId:"page-original",credentialVersion:"credential-v1",accountVersion:"account-v1",pageTasksSha256,task:"page_post_delete"},resolveCredential:async()=>({externalAccountId:"page-rebound",accessToken:"token",scope:"pages_manage_posts pages_read_engagement",pageTasks:["CREATE_CONTENT"],credentialVersion:"credential-v1",accountVersion:"account-v1"})});
    await expect(connector.correctionCapabilities({workspaceId:"workspace-1",accountId:"account-facebook",platform:"facebook"})).resolves.toMatchObject({actions:{delete_remote:{state:"contract_probe_required"}}});
  });

  it("fails the Facebook delete probe closed when the current Page task snapshot changes", async () => {
    const pageTasksSha256=canonicalSha256({schemaVersion:"originpost.facebook-page-tasks.v1",tasks:["CREATE_CONTENT"]});
    const connector=new FacebookPageOfficialConnector({apiVersion:"v26.0",appSecret:"app-secret",appId:"app-1",environment:"test",fetch:vi.fn().mockResolvedValue(response({id:"page-1",tasks:["MODERATE"]})),baseUrl:"https://graph.facebook.test",pageDeleteContractProbe:{apiVersion:"v26.0",verifiedAt:"2026-08-29T06:00:00.000Z",expiresAt:"2026-09-10T06:00:00.000Z",environment:"test",appId:"app-1",accountId:"account-facebook",externalPageId:"page-1",credentialVersion:"credential-v1",accountVersion:"account-v1",pageTasksSha256,task:"page_post_delete"},resolveCredential:async()=>({externalAccountId:"page-1",accessToken:"token",scope:"pages_manage_posts pages_read_engagement",pageTasks:["CREATE_CONTENT"],credentialVersion:"credential-v1",accountVersion:"account-v1"})});
    await expect(connector.correctionCapabilities({workspaceId:"workspace-1",accountId:"account-facebook",platform:"facebook"})).resolves.toMatchObject({actions:{delete_remote:{state:"contract_probe_required"}}});
  });

  it("allows manual identity preflight without destructive mutation scopes", async () => {
    const instagramTransport=vi.fn().mockResolvedValue(response({id:"media-1",media_type:"IMAGE",media_product_type:"FEED",owner:{id:"ig-1"}}));
    const instagram=new InstagramOfficialConnector({apiVersion:"v26.0",facebookGraphBaseUrl:"https://graph.facebook.test",fetch:instagramTransport,resolveCredential:async()=>({externalAccountId:"ig-1",accessToken:"token",connectionMode:"instagram_login",scope:"instagram_business_basic"})});
    await expect(instagram.preflightManualCorrection({workspaceId:"workspace-1",brandId:"brand-1",publishProofId:"proof-instagram",contentItemId:"content-1",draftId:"draft-1",draftSha256:sha("draft"),platform:"instagram",accountId:"account-instagram",externalPostId:"media-1",mutation:{action:"manual_remove"}})).resolves.toMatchObject({providerOwnerId:"ig-1",state:"live"});
    const youtubeTransport=vi.fn().mockResolvedValue(response({items:[{id:"video-1",snippet:{channelId:"channel-1"},status:{privacyStatus:"public"}}]}));
    const youtube=new YouTubeOfficialConnector({apiBaseUrl:"https://youtube.test/v3",fetch:youtubeTransport,resolveCredential:async()=>({externalAccountId:"channel-1",accessToken:"token",scope:"https://www.googleapis.com/auth/youtube.readonly"})});
    await expect(youtube.preflightManualCorrection({workspaceId:"workspace-1",brandId:"brand-1",publishProofId:"proof-youtube",contentItemId:"content-1",draftId:"draft-1",draftSha256:sha("draft"),platform:"youtube",accountId:"account-youtube",externalPostId:"video-1",mutation:{action:"manual_remove"}})).resolves.toMatchObject({providerOwnerId:"channel-1",state:"public"});
    expect(instagramTransport.mock.calls[0]?.[1]).not.toMatchObject({method:"DELETE"});
    expect(youtubeTransport.mock.calls[0]?.[1]).not.toMatchObject({method:"DELETE"});
  });

  it("makes YouTube private with the scoped credential, preserves mutable status, and reads back the result", async () => {
    const publicVideo = { id: "video-1", snippet: { channelId: "channel-1" }, status: { privacyStatus: "public", embeddable: true, license: "youtube", publicStatsViewable: true, selfDeclaredMadeForKids: false, containsSyntheticMedia: true } };
    const privateVideo = { ...publicVideo, status: { ...publicVideo.status, privacyStatus: "private" } };
    const transport = vi.fn()
      .mockResolvedValueOnce(response({ items: [publicVideo] }))
      .mockResolvedValueOnce(response({ id: "video-1", status: privateVideo.status }))
      .mockResolvedValueOnce(response({ items: [privateVideo] }));
    const connector = new YouTubeOfficialConnector({
      apiBaseUrl: "https://youtube.test/v3", fetch: transport,
      resolveCredential: async () => ({ externalAccountId: "channel-1", accessToken: "youtube-token", scope: "https://www.googleapis.com/auth/youtube.force-ssl" }),
    });
    const request = await correction(connector, proof("youtube", "video-1"), { action: "make_private" });
    await expect(connector.executeCorrection(request)).resolves.toMatchObject({ kind: "provider_confirmed", after: { state: "private" } });
    const update = JSON.parse(String((transport.mock.calls[1]?.[1] as RequestInit).body)) as { status: Record<string, unknown> };
    expect(update.status).toEqual({ privacyStatus: "private", embeddable: true, license: "youtube", publicStatsViewable: true, selfDeclaredMadeForKids: false, containsSyntheticMedia: true });
  });

  it("reports YouTube scope expansion without attempting a write", async () => {
    const connector = new YouTubeOfficialConnector({ resolveCredential: async () => ({ externalAccountId: "channel-1", accessToken: "token", scopes: ["https://www.googleapis.com/auth/youtube.upload"] }) });
    await expect(connector.correctionCapabilities({ workspaceId: "workspace-1", accountId: "account-youtube", platform: "youtube" })).resolves.toMatchObject({
      actions: { make_private: { state: "scope_required" }, delete_remote: { state: "scope_required" } },
    });
  });
});
