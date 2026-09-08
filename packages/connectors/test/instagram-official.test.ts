import { describe, expect, it } from "vitest";
import { approveInstagramPublishSettings, bindInstagramPublishApproval, instagramRequestedUsernamesHash } from "@originpost/domain";
import { InstagramOfficialConnector, type AnalyticsRequest, type PublishRequest } from "../src/index.js";

function request(format: "image" | "carousel" | "reel" | "story", media: PublishRequest["media"]): PublishRequest {
  return { workspaceId: "workspace-1", contentItemId: "content-1", targetId: "target-1", accountId: "account-1", draftSha256:"d".repeat(64), platform: "instagram", format, caption: "Verified caption", media, idempotencyKey: "publish:target-1:v1", settings: {} };
}

function collaboratorSettings(usernames:readonly string[],accountId="account-1"){
  const settings=approveInstagramPublishSettings({collaborators:usernames});
  return{...settings,approvalBinding:bindInstagramPublishApproval({accountId,draftSha256:"d".repeat(64),approvedSettingsSha256:settings.approvedSettingsSha256})};
}
function reelSettings(reelCover:Parameters<typeof approveInstagramPublishSettings>[0]["reelCover"],shareToFeed=true){const settings=approveInstagramPublishSettings({collaborators:[],shareToFeed,reelCover});return{...settings,approvalBinding:bindInstagramPublishApproval({accountId:"account-1",draftSha256:"d".repeat(64),approvedSettingsSha256:settings.approvedSettingsSha256})};}
function aiSettings(isAiGenerated=true){const settings=approveInstagramPublishSettings({collaborators:[],isAiGenerated});return{...settings,approvalBinding:bindInstagramPublishApproval({accountId:"account-1",draftSha256:"d".repeat(64),approvedSettingsSha256:settings.approvedSettingsSha256})};}
const collaboratorCredential={externalAccountId:"ig-123",accessToken:"token",connectionMode:"facebook_login" as const,canonicalUsername:"publisher",scopes:["instagram_basic","instagram_content_publish","pages_read_engagement"],endpointFamily:"instagram_api_with_facebook_login" as const,collaboratorEndpointProbe:{state:"verified" as const,apiVersion:"v99.0"}};
const requestedUsernames=["cohost","pending.user","not.visible"];
const collaboratorStatusRequest={workspaceId:"workspace-1",brandId:"brand-1",contentItemId:"content-1",accountId:"account-1",proofId:"proof-1",externalMediaId:"media-900",requestedUsernames,requestedUsernamesSha256:instagramRequestedUsernamesHash(requestedUsernames)};

const analyticsRequest: AnalyticsRequest = {
  workspaceId: "workspace-1",
  contentItemId: "content-1",
  proofId: "proof-1",
  accountId: "account-1",
  platform: "instagram",
  externalPostId: "media-900",
  publishedAt: "2026-08-27T12:00:00.000Z",
};

function fakeGraph() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let container = 0;
  const transport = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes("media_publish")) return new Response(JSON.stringify({ id: "media-900" }), { status: 200 });
    if (url.endsWith("/media-900?fields=permalink%2Cis_ai_generated")) return new Response(JSON.stringify({ id:"media-900", permalink: "https://www.instagram.com/p/checked/", is_ai_generated:true }), { status: 200 });
    if (init?.method === "POST" && url.endsWith("/media")) return new Response(JSON.stringify({ id: `container-${++container}` }), { status: 200 });
    if (url.includes("fields=status_code")) return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
    return new Response(JSON.stringify({ error: { code: 100 } }), { status: 400 });
  };
  return { calls, transport: transport as typeof fetch };
}

const image = { id: "image-1", type: "image" as const, url: "https://api.example/media/image", mimeType: "image/png", sha256: "a".repeat(64), sizeBytes: 10, inspectionStatus: "ready" as const, widthPixels: 1080, heightPixels: 1350, altText: "Image" };
const video = { id: "video-1", type: "video" as const, url: "https://api.example/media/video", mimeType: "video/mp4", sha256: "b".repeat(64), sizeBytes: 20, inspectionStatus: "ready" as const, widthPixels: 1080, heightPixels: 1920, durationMs: 60_000, altText: "Video" };
const storyImage = { ...image, url: "https://api.example/media/story-image", mimeType: "image/jpeg", widthPixels: 1080, heightPixels: 1920, rights: "owned" as const };
const storyVideo = { ...video, url: "https://api.example/media/story-video", rights: "cleared" as const };

describe("official Instagram connector", () => {
  it("advertises and creates a basic image Story for a server-verified BUSINESS account", async () => {
    const graph = fakeGraph();
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      baseUrl: "https://graph.test",
      fetch: graph.transport,
      pollIntervalMs: 0,
      resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "token", accountType: "BUSINESS" }),
    });
    const publishRequest = request("story", [storyImage]);

    expect(connector.manifest.capabilities.formats).toContain("story");
    await expect(connector.getStoryCapability(publishRequest)).resolves.toMatchObject({ state: "supported", accountType: "BUSINESS" });
    await connector.createOperation(publishRequest);

    const body = graph.calls.find((call) => call.init?.method === "POST")?.init?.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({ media_type: "STORIES", image_url: storyImage.url });
    expect(body.has("caption")).toBe(false);
    expect(body.has("collaborators")).toBe(false);
    expect(body.has("share_to_feed")).toBe(false);
    expect(body.has("cover_url")).toBe(false);
    expect(body.has("thumb_offset")).toBe(false);
  });

  it("creates a basic video Story with exactly media_type=STORIES and video_url", async () => {
    const graph = fakeGraph();
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      baseUrl: "https://graph.test",
      fetch: graph.transport,
      pollIntervalMs: 0,
      resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "token", accountType: "BUSINESS" }),
    });

    await connector.createOperation(request("story", [storyVideo]));
    const body = graph.calls.find((call) => call.init?.method === "POST")?.init?.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({ media_type: "STORIES", video_url: storyVideo.url });
  });

  it("puts an approved AI disclosure only on the Story container and verifies it after publish",async()=>{
    const graph=fakeGraph();
    const connector=new InstagramOfficialConnector({apiVersion:"v99.0",baseUrl:"https://graph.test",fetch:graph.transport,pollIntervalMs:0,resolveCredential:async()=>({externalAccountId:"ig-123",accessToken:"token",accountType:"BUSINESS"})});
    const publishRequest={...request("story",[storyImage]),settings:aiSettings(true)};
    const created=await connector.createOperation(publishRequest);
    const body=graph.calls.find((call)=>call.init?.method==="POST")?.init?.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({media_type:"STORIES",image_url:storyImage.url,is_ai_generated:"true"});
    const result=await connector.finalizeOperation(publishRequest,created.containerId);
    expect(result.rawResponse).toMatchObject({isAiGenerated:true,mediaId:"media-900"});
  });

  it("rejects a PNG Story image before creating a provider container", async () => {
    const graph = fakeGraph();
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      baseUrl: "https://graph.test",
      fetch: graph.transport,
      resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "token", accountType: "BUSINESS" }),
    });
    await expect(connector.createOperation(request("story", [{ ...storyImage, mimeType: "image/png" }]))).rejects.toMatchObject({ code: "instagram_story_image_must_be_jpeg" });
    expect(graph.calls).toEqual([]);
  });

  it("treats long Story copy as an internal note and omits it from the provider body", async () => {
    const graph = fakeGraph();
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      baseUrl: "https://graph.test",
      fetch: graph.transport,
      resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "token", accountType: "BUSINESS" }),
    });
    const publishRequest = { ...request("story", [storyImage]), caption: "Internal review note ".repeat(150) };
    expect(publishRequest.caption.length).toBeGreaterThan(connector.manifest.limits.captionCharacters);
    await connector.createOperation(publishRequest);
    const body = graph.calls.find((call) => call.init?.method === "POST")?.init?.body as URLSearchParams;
    expect(body.has("caption")).toBe(false);
  });

  it.each([
    ["Creator", "MEDIA_CREATOR" as const, "instagram_story_business_account_required"],
    ["legacy", undefined, "instagram_story_account_type_unavailable"],
  ])("fails closed for a %s credential", async (_label, accountType, code) => {
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "token", ...(accountType ? { accountType } : {}) }),
    });
    const publishRequest = request("story", [storyImage]);

    await expect(connector.validate(publishRequest)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ code, severity: "error" })]));
    await expect(connector.createOperation(publishRequest)).rejects.toMatchObject({ code });
  });

  it.each(["link", "sticker", "music", "poll", "location", "collaborators", "shareToFeed", "reelCover"])(
    "rejects Story %s settings and sends no provider request",
    async (field) => {
      const graph = fakeGraph();
      const connector = new InstagramOfficialConnector({
        apiVersion: "v99.0",
        fetch: graph.transport,
        resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "token", accountType: "BUSINESS" }),
      });
      const publishRequest = { ...request("story", [storyImage]), settings: { [field]: "untrusted" } };

      await expect(connector.createOperation(publishRequest)).rejects.toMatchObject({ code: "instagram_story_settings_unsupported" });
      expect(graph.calls).toEqual([]);
    },
  );

  it("keeps an uncertain Story finalize fenced for reconciliation", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).includes("media_publish")) throw new TypeError("connection ended");
      return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
    };
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      baseUrl: "https://graph.test",
      fetch: transport as typeof fetch,
      resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "token", accountType: "BUSINESS" }),
    });

    await expect(connector.finalizeOperation(request("story", [storyImage]), "story-container-1")).rejects.toMatchObject({
      name: "ProviderPublishError",
      code: "uncertain",
      detail: { containerId: "story-container-1" },
      retrySafety: "reconcile_first",
    });
    expect(calls.filter((call) => call.url.includes("media_publish"))).toHaveLength(1);
  });

  it.each([["image", [image]], ["reel", [video]], ["carousel", [image, video]]] as const)("publishes %s through containers without putting the token in a URL", async (format, media) => {
    const graph = fakeGraph();
    const connector = new InstagramOfficialConnector({ apiVersion: "v99.0", baseUrl: "https://graph.test", facebookGraphBaseUrl: "https://facebook-graph.test", fetch: graph.transport, pollIntervalMs: 0, resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "server-only-token" }) });
    const result = await connector.publish(request(format, [...media]));
    expect(result).toMatchObject({ status: "published", externalPostId: "media-900", liveUrl: "https://www.instagram.com/p/checked/" });
    expect(graph.calls.every((call) => !call.url.includes("server-only-token"))).toBe(true);
    expect(graph.calls.every((call) => new Headers(call.init?.headers).get("authorization") === "Bearer server-only-token")).toBe(true);
    expect(graph.calls.every((call) => call.url.startsWith("https://graph.test/v99.0/"))).toBe(true);
    expect(graph.calls.every((call) => call.init?.redirect === "error")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("server-only-token");
  });

  it("stops when provider processing reports an error", async () => {
    const transport = async (input: string | URL | Request, init?: RequestInit) => init?.method === "POST"
      ? new Response(JSON.stringify({ id: "container-error" }), { status: 200 })
      : new Response(JSON.stringify({ status_code: "ERROR" }), { status: 200 });
    const connector = new InstagramOfficialConnector({ apiVersion: "v99.0", fetch: transport as typeof fetch, pollIntervalMs: 0, resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "token" }) });
    await expect(connector.publish(request("image", [image]))).rejects.toThrow("processing error");
  });

  it("supports durable create, wait, and finalize stages", async () => {
    const graph = fakeGraph();
    const connector = new InstagramOfficialConnector({ apiVersion: "v99.0", baseUrl: "https://graph.test", fetch: graph.transport, pollIntervalMs: 0, resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "server-only-token" }) });
    const operation = await connector.createOperation(request("image", [image]));
    expect(operation).toMatchObject({ containerId: "container-1", childContainerIds: [], collaboratorInviteProof: { requestState: "not_requested" } });
    expect(graph.calls.some((call) => call.url.includes("media_publish"))).toBe(false);
    await connector.waitUntilOperationReady(request("image", [image]), operation.containerId);
    expect(graph.calls.some((call) => call.url.includes("media_publish"))).toBe(false);
    const result = await connector.finalizeOperation(request("image", [image]), operation.containerId);
    expect(result).toMatchObject({ status: "published", externalPostId: "media-900" });
  });

  it.each([
    ["image",[image]],
    ["reel",[video]],
  ] as const)("sends and verifies the approved native AI label for an Instagram %s",async(format,media)=>{
    const graph=fakeGraph();
    const connector=new InstagramOfficialConnector({apiVersion:"v99.0",baseUrl:"https://graph.test",fetch:graph.transport,pollIntervalMs:0,resolveCredential:async()=>({externalAccountId:"ig-123",accessToken:"token"})});
    const publishRequest={...request(format,[...media]),settings:aiSettings(true)};
    const result=await connector.publish(publishRequest);
    const createBody=graph.calls.find((call)=>call.init?.method==="POST"&&!call.url.includes("media_publish"))?.init?.body as URLSearchParams;
    expect(createBody.get("is_ai_generated")).toBe("true");
    expect(result.rawResponse).toMatchObject({isAiGenerated:true});
  });

  it("puts the AI disclosure on a carousel parent and never on child containers",async()=>{
    const graph=fakeGraph();
    const connector=new InstagramOfficialConnector({apiVersion:"v99.0",baseUrl:"https://graph.test",fetch:graph.transport,pollIntervalMs:0,resolveCredential:async()=>({externalAccountId:"ig-123",accessToken:"token"})});
    await connector.createOperation({...request("carousel",[image,{...image,id:"image-2",url:"https://api.example/media/image-2",sha256:"e".repeat(64)}]),settings:aiSettings(true)});
    const bodies=graph.calls.filter((call)=>call.init?.method==="POST").map((call)=>call.init?.body as URLSearchParams);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.has("is_ai_generated")).toBe(false);
    expect(bodies[1]?.has("is_ai_generated")).toBe(false);
    expect(bodies[2]?.get("is_ai_generated")).toBe("true");
  });

  it("fails uncertain when Instagram does not confirm a requested AI label",async()=>{
    const transport=async(input:string|URL|Request,init?:RequestInit)=>{
      const url=String(input);
      if(url.includes("media_publish"))return new Response(JSON.stringify({id:"media-900"}),{status:200});
      if(url.includes("fields=permalink%2Cis_ai_generated"))return new Response(JSON.stringify({id:"media-900",permalink:"https://www.instagram.com/p/checked/",is_ai_generated:false}),{status:200});
      if(init?.method==="POST")return new Response(JSON.stringify({id:"container-ai"}),{status:200});
      return new Response(JSON.stringify({status_code:"FINISHED"}),{status:200});
    };
    const connector=new InstagramOfficialConnector({apiVersion:"v99.0",baseUrl:"https://graph.test",fetch:transport as typeof fetch,pollIntervalMs:0,resolveCredential:async()=>({externalAccountId:"ig-123",accessToken:"token"})});
    const publishRequest={...request("image",[image]),settings:aiSettings(true)};
    await expect(connector.publish(publishRequest)).rejects.toMatchObject({code:"uncertain",retrySafety:"reconcile_first",detail:{externalPostId:"media-900"}});
  });

  it.each([
    ["custom image",reelSettings({mode:"custom_image",mediaId:"cover-1",mediaSha256:"c".repeat(64)}),{cover_url:"https://api.example/media/cover",thumb_offset:null}],
    ["video frame",reelSettings({mode:"video_frame",offsetMs:4321},false),{cover_url:null,thumb_offset:"4321"}],
    ["Instagram default",reelSettings({mode:"instagram_default"}),{cover_url:null,thumb_offset:null}],
  ] as const)("sends one approved Reel cover mode: %s",async(_label,settings,expected)=>{
    const graph=fakeGraph();const connector=new InstagramOfficialConnector({apiVersion:"v99.0",baseUrl:"https://graph.test",fetch:graph.transport,pollIntervalMs:0,resolveCredential:async()=>({externalAccountId:"ig-123",accessToken:"token"})});
    const cover={...image,id:"cover-1",url:"https://api.example/media/cover",sha256:"c".repeat(64)};
    const publishRequest={...request("reel",[video]),settings,...(settings.reelCover?.mode==="custom_image"?{coverMedia:cover}:{})};
    const issues=await connector.validate(publishRequest);expect(issues.filter((issue)=>issue.severity==="error")).toEqual([]);
    await connector.createOperation(publishRequest);
    const body=graph.calls.find((call)=>call.init?.method==="POST")?.init?.body as URLSearchParams;
    expect(body.get("cover_url")).toBe(expected.cover_url);expect(body.get("thumb_offset")).toBe(expected.thumb_offset);
    expect(body.get("share_to_feed")).toBe(settings.shareToFeed===false?"false":"true");
  });

  it("reads Insights by metric name and omits values Instagram did not return", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ data: [
        { name: "saved", period: "lifetime", total_value: { value: 7 } },
        { name: "views", period: "lifetime", values: [{ value: 125 }] },
        { name: "likes", period: "lifetime", values: [{ value: 18 }] },
        { name: "reach", period: "lifetime", total_value: { value: 91 } },
        { name: "comments", period: "lifetime", values: [] },
        { name: "shares", period: "lifetime", total_value: { value: 4 } },
      ] }), { status: 200 });
    };
    const connector = new InstagramOfficialConnector({ apiVersion: "v25.0", baseUrl: "https://graph.test", fetch: transport as typeof fetch, resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "server-only-token" }) });
    const result = await connector.readPostAnalytics(analyticsRequest);

    expect(result.status).toBe("ready");
    expect(result.metrics).toMatchObject([
      { key: "views", value: 125, unit: "count" },
      { key: "reach", value: 91, unit: "count" },
      { key: "likes", value: 18, unit: "count" },
      { key: "shares", value: 4, unit: "count" },
      { key: "saves", value: 7, unit: "count" },
    ]);
    expect(result.metrics.some((metric) => metric.key === "comments")).toBe(false);
    const call = calls[0]!;
    expect(new URL(call.url).searchParams.get("metric")).toBe("views,reach,likes,comments,saved,shares");
    expect(call.url).not.toContain("server-only-token");
    expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer server-only-token");
  });

  it("returns unavailable rather than fake zeroes when Insights has no data", async () => {
    const connector = new InstagramOfficialConnector({
      apiVersion: "v25.0",
      fetch: (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch,
      resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "token" }),
    });
    await expect(connector.readPostAnalytics(analyticsRequest)).resolves.toMatchObject({ status: "unavailable", metrics: [] });
  });

  it.each([
    [401, { error: { code: 190, type: "OAuthException" } }, "permission_missing"],
    [400, { error: { code: 100, type: "OAuthException" } }, "unsupported"],
    [429, { error: { code: 613, type: "OAuthException" } }, "provider_failed"],
  ] as const)("classifies analytics provider errors with HTTP %s", async (status, body, code) => {
    const connector = new InstagramOfficialConnector({
      apiVersion: "v25.0",
      fetch: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch,
      resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "token" }),
    });
    await expect(connector.readPostAnalytics(analyticsRequest)).rejects.toMatchObject({ name: "ProviderAnalyticsError", code });
  });

  it.each(["image", "reel"] as const)("puts collaborators on the %s container only for Facebook Login", async (format) => {
    const graph = fakeGraph();
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      baseUrl: "https://instagram-graph.test",
      facebookGraphBaseUrl: "https://facebook-graph.test",
      fetch: graph.transport,
      pollIntervalMs: 0,
      resolveCredential: async () => collaboratorCredential,
    });
    const settings = collaboratorSettings(["@CoHost", "news.room"]);
    const publishRequest = { ...request(format, format === "image" ? [image] : [video]), settings };

    const operation = await connector.createOperation(publishRequest);
    await connector.waitUntilOperationReady(publishRequest, operation.containerId);
    const body = graph.calls.find((call) => call.init?.method === "POST")?.init?.body as URLSearchParams;
    expect(body.get("collaborators")).toBe('["cohost","news.room"]');
    expect(operation.collaboratorInviteProof).toMatchObject({
      requestState: "requested_unverified",
      requestedUsernames: ["cohost", "news.room"],
      providerConnectionMode: "facebook_login",
    });
    expect(graph.calls.every((call) => call.url.startsWith("https://facebook-graph.test/v99.0/"))).toBe(true);
    expect(graph.calls.every((call) => call.init?.redirect === "error")).toBe(true);
  });

  it("rejects unpinned or non-HTTPS provider origins", () => {
    const options = { apiVersion: "v99.0", resolveCredential: async () => collaboratorCredential };
    expect(() => new InstagramOfficialConnector({ ...options, facebookGraphBaseUrl: "http://graph.facebook.test" })).toThrow("exact HTTPS origins");
    expect(() => new InstagramOfficialConnector({ ...options, facebookGraphBaseUrl: "https://graph.facebook.test/v99.0" })).toThrow("exact HTTPS origins");
    expect(() => new InstagramOfficialConnector({ ...options, facebookGraphBaseUrl: "https://token@graph.facebook.test" })).toThrow("exact HTTPS origins");
  });

  it("does not reuse a custom Instagram Login origin for collaborator publishing", async () => {
    const graph = fakeGraph();
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      baseUrl: "https://instagram-graph.test",
      fetch: graph.transport,
      resolveCredential: async () => collaboratorCredential,
    });

    await connector.createOperation({ ...request("image", [image]), settings: collaboratorSettings(["cohost"]) });

    expect(graph.calls[0]?.url).toBe("https://graph.facebook.com/v99.0/ig-123/media");
  });

  it("puts collaborators on a carousel parent and never on its children", async () => {
    const graph = fakeGraph();
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      baseUrl: "https://instagram-graph.test",
      facebookGraphBaseUrl: "https://facebook-graph.test",
      fetch: graph.transport,
      pollIntervalMs: 0,
      resolveCredential: async () => collaboratorCredential,
    });
    const settings = collaboratorSettings(["cohost"]);

    await connector.createOperation({ ...request("carousel", [image, video]), settings });
    const bodies = graph.calls
      .filter((call) => call.init?.method === "POST" && call.url.endsWith("/media"))
      .map((call) => call.init?.body as URLSearchParams);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.has("collaborators")).toBe(false);
    expect(bodies[1]?.has("collaborators")).toBe(false);
    expect(bodies[2]?.get("media_type")).toBe("CAROUSEL");
    expect(bodies[2]?.get("collaborators")).toBe('["cohost"]');
    expect(graph.calls.every((call) => call.url.startsWith("https://facebook-graph.test/v99.0/"))).toBe(true);
    expect(graph.calls.every((call) => call.init?.redirect === "error")).toBe(true);
  });

  it("finalizes collaborator media through the pinned Facebook Graph origin", async () => {
    const graph = fakeGraph();
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      baseUrl: "https://instagram-graph.test",
      facebookGraphBaseUrl: "https://facebook-graph.test",
      fetch: graph.transport,
      resolveCredential: async () => collaboratorCredential,
    });
    const publishRequest = { ...request("image", [image]), settings: collaboratorSettings(["cohost"]) };

    await connector.finalizeOperation(publishRequest, "container-1");

    expect(graph.calls).toHaveLength(2);
    expect(graph.calls[0]?.url).toBe("https://facebook-graph.test/v99.0/ig-123/media_publish");
    expect(graph.calls[1]?.url).toBe("https://facebook-graph.test/v99.0/media-900?fields=permalink%2Cis_ai_generated");
    expect(graph.calls.every((call) => call.init?.redirect === "error")).toBe(true);
  });

  it("fails closed on current Instagram Login credentials before creating a container", async () => {
    const graph = fakeGraph();
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      baseUrl: "https://graph.test",
      fetch: graph.transport,
      resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "token" }),
    });

    await expect(connector.createOperation({
      ...request("image", [image]),
      settings: collaboratorSettings(["cohost"]),
    })).rejects.toMatchObject({ code: "instagram_collaborators_connection_unsupported" });
    expect(graph.calls).toHaveLength(0);
  });

  it("requires exact scopes, endpoint family, and a matching verified probe",async()=>{
    const missingScopes=new InstagramOfficialConnector({apiVersion:"v99.0",resolveCredential:async()=>({...collaboratorCredential,scopes:["instagram_basic"]})});
    await expect(missingScopes.getCollaboratorCapability(request("image",[image]))).resolves.toMatchObject({state:"unsupported",reason:"required_scopes_missing"});
    const wrongFamily=new InstagramOfficialConnector({apiVersion:"v99.0",resolveCredential:async()=>({...collaboratorCredential,endpointFamily:"instagram_api_with_instagram_login"})});
    await expect(wrongFamily.getCollaboratorCapability(request("image",[image]))).resolves.toMatchObject({state:"unsupported",reason:"endpoint_family_unsupported"});
    const staleProbe=new InstagramOfficialConnector({apiVersion:"v99.0",resolveCredential:async()=>({...collaboratorCredential,collaboratorEndpointProbe:{state:"verified",apiVersion:"v98.0"}})});
    await expect(staleProbe.getCollaboratorCapability(request("image",[image]))).resolves.toMatchObject({state:"unsupported",reason:"endpoint_probe_required"});
    const supported=new InstagramOfficialConnector({apiVersion:"v99.0",resolveCredential:async()=>collaboratorCredential});
    await expect(supported.getCollaboratorCapability(request("image",[image]))).resolves.toMatchObject({state:"supported",providerVersion:"v99.0",requiredScopes:["instagram_basic","instagram_content_publish","pages_read_engagement"]});
    await expect(supported.getCollaboratorIdentity(request("image",[image]))).resolves.toMatchObject({publishingUsername:"publisher",capability:{state:"supported"}});
  });

  it("uses only the canonical publisher username for self-invite protection",async()=>{
    const connector=new InstagramOfficialConnector({apiVersion:"v99.0",resolveCredential:async()=>({...collaboratorCredential,canonicalUsername:"Publisher",username:"untrusted-display"})});
    await expect(connector.createOperation({...request("image",[image]),settings:collaboratorSettings(["publisher"])})).rejects.toMatchObject({code:"instagram_collaborator_self_invite"});
  });

  it("rejects a collaborator approval binding for another account or draft",async()=>{
    const connector=new InstagramOfficialConnector({apiVersion:"v99.0",resolveCredential:async()=>collaboratorCredential});
    const wrongAccount=await connector.validate({...request("image",[image]),settings:collaboratorSettings(["cohost"],"other-account")});
    expect(wrongAccount).toEqual(expect.arrayContaining([expect.objectContaining({code:"instagram_collaborator_approval_binding_stale",severity:"error"})]));
    const settings=collaboratorSettings(["cohost"]);
    const wrongDraft=await connector.validate({...request("image",[image]),draftSha256:"e".repeat(64),settings});
    expect(wrongDraft).toEqual(expect.arrayContaining([expect.objectContaining({code:"instagram_collaborator_approval_binding_stale",severity:"error"})]));
  });

  it("returns bounded provider status snapshots without inventing a declined state", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = async (input:string|URL|Request, init?: RequestInit) => {calls.push({ url: String(input), init });return new Response(JSON.stringify({ data: [
      { id: "scoped-1", username: "cohost", invite_status: "Accepted" },
      { id: "scoped-2", username: "pending.user", invite_status: "Pending" },
    ] }), { status: 200 });};
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      baseUrl: "https://instagram-graph.test",
      facebookGraphBaseUrl:"https://facebook-graph.test",
      fetch: transport as typeof fetch,
      resolveCredential: async () => collaboratorCredential,
    });

    const result = await connector.readCollaboratorStatuses(collaboratorStatusRequest);
    expect(result.snapshots).toMatchObject([
      { workspaceId:"workspace-1",brandId:"brand-1",contentItemId:"content-1",proofId:"proof-1",accountId:"account-1",requestedUsernamesSha256:instagramRequestedUsernamesHash(["cohost","pending.user","not.visible"]),username: "cohost", status: "accepted", providerScopedUserId: "scoped-1" },
      { username: "pending.user", status: "pending", providerScopedUserId: "scoped-2" },
      { username: "not.visible", status: "not_returned" },
    ]);
    expect(result).toMatchObject({complete:true,availability:"available"});
    expect(result.rawResponseSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(calls[0]?.url).toContain("https://facebook-graph.test/v99.0/media-900/collaborators");
    expect(calls[0]?.init?.redirect).toBe("error");
  });

  it("fails incomplete on collaborator status pagination instead of reporting a partial set", async () => {
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      facebookGraphBaseUrl: "https://facebook-graph.test",
      fetch: (async () => new Response(JSON.stringify({
        data: [{ id: "scoped-1", username: "cohost", invite_status: "Accepted" }],
        paging: { next: "https://facebook-graph.test/v99.0/media-900/collaborators?after=secret" },
      }), { status: 200 })) as typeof fetch,
      resolveCredential: async () => collaboratorCredential,
    });

    await expect(connector.readCollaboratorStatuses(collaboratorStatusRequest)).resolves.toMatchObject({
      complete: false,
      availability: "invalid_response",
      retry: { recommended: false },
    });
  });

  it("cancels a chunked collaborator status response once the 64 KiB cap is exceeded", async () => {
    let cancelled = false;
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40_000));
        controller.enqueue(new Uint8Array(40_000));
      },
      cancel() { cancelled = true; },
    });
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      fetch: (async (_input, init) => {
        expect(init?.redirect).toBe("error");
        return new Response(oversizedStream, { status: 200 });
      }) as typeof fetch,
      resolveCredential: async () => collaboratorCredential,
    });

    await expect(connector.readCollaboratorStatuses(collaboratorStatusRequest)).resolves.toMatchObject({
      complete: false,
      availability: "invalid_response",
    });
    expect(cancelled).toBe(true);
  });

  it("rejects declared oversized collaborator status bodies before reading them", async () => {
    let cancelled = false;
    const declaredOversizedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":[]}'));
      },
      cancel() { cancelled = true; },
    });
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      fetch: (async () => new Response(declaredOversizedStream, { status: 200, headers: { "content-length": "70000" } })) as typeof fetch,
      resolveCredential: async () => collaboratorCredential,
    });

    await expect(connector.readCollaboratorStatuses(collaboratorStatusRequest)).resolves.toMatchObject({
      complete: false,
      availability: "invalid_response",
    });
    expect(cancelled).toBe(true);
  });

  it("returns incomplete bounded status results with explicit recovery semantics",async()=>{
    const credentialFailure=new InstagramOfficialConnector({apiVersion:"v99.0",resolveCredential:async()=>{throw new Error("secret failure");}});
    const credentialResult=await credentialFailure.readCollaboratorStatuses(collaboratorStatusRequest);
    expect(credentialResult).toMatchObject({complete:false,availability:"credential_unavailable",retry:{recommended:false}});
    expect(credentialResult.snapshots[0]).toMatchObject({workspaceId:"workspace-1",brandId:"brand-1",contentItemId:"content-1",accountId:"account-1",status:"unavailable"});
    let redirectMode: RequestRedirect | undefined;
    const transportFailure=new InstagramOfficialConnector({apiVersion:"v99.0",fetch:(async(_input,init)=>{redirectMode=init?.redirect;throw new TypeError("redirect blocked");}) as typeof fetch,resolveCredential:async()=>collaboratorCredential});
    await expect(transportFailure.readCollaboratorStatuses(collaboratorStatusRequest)).resolves.toMatchObject({complete:false,availability:"transport_failed",retry:{recommended:true}});
    expect(redirectMode).toBe("error");
    const rateLimited=new InstagramOfficialConnector({apiVersion:"v99.0",fetch:(async()=>new Response(JSON.stringify({error:{code:613,error_subcode:9}}),{status:429,headers:{"retry-after":"60"}})) as typeof fetch,resolveCredential:async()=>collaboratorCredential});
    await expect(rateLimited.readCollaboratorStatuses(collaboratorStatusRequest)).resolves.toMatchObject({complete:false,availability:"provider_failed",error:{providerCode:613,providerSubcode:9},retry:{recommended:true,afterSeconds:60}});
    const malformed=new InstagramOfficialConnector({apiVersion:"v99.0",fetch:(async()=>new Response(JSON.stringify({data:[{username:"cohost",invite_status:"Declined"}]}),{status:200})) as typeof fetch,resolveCredential:async()=>collaboratorCredential});
    await expect(malformed.readCollaboratorStatuses(collaboratorStatusRequest)).resolves.toMatchObject({complete:false,availability:"invalid_response",retry:{recommended:false}});
    const oversized=new InstagramOfficialConnector({apiVersion:"v99.0",fetch:(async()=>new Response(JSON.stringify({data:[],padding:"x".repeat(70_000)}),{status:200})) as typeof fetch,resolveCredential:async()=>collaboratorCredential});
    await expect(oversized.readCollaboratorStatuses(collaboratorStatusRequest)).resolves.toMatchObject({complete:false,availability:"invalid_response",retry:{recommended:false}});
    const wrongHash={...collaboratorStatusRequest,requestedUsernamesSha256:"0".repeat(64)};
    await expect(malformed.readCollaboratorStatuses(wrongHash)).resolves.toMatchObject({complete:false,availability:"invalid_response",snapshots:[]});
  });

  it("marks finalize ambiguity as reconcile-first instead of retry-safe", async () => {
    let publishCalls = 0;
    const transport = async (input: string | URL | Request) => {
      if (String(input).includes("media_publish")) {
        publishCalls += 1;
        throw new TypeError("connection reset");
      }
      return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
    };
    const connector = new InstagramOfficialConnector({
      apiVersion: "v99.0",
      fetch: transport as typeof fetch,
      resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "token" }),
    });

    await expect(connector.finalizeOperation(request("image", [image]), "container-1")).rejects.toMatchObject({
      name: "ProviderPublishError",
      code: "uncertain",
      retrySafety: "reconcile_first",
      detail: { containerId: "container-1" },
    });
    expect(publishCalls).toBe(1);
  });
});
