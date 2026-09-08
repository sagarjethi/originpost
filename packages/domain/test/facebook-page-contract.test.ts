import { describe, expect, it } from "vitest";
import {
  InMemoryConnectedAccountRepository,
  InMemoryOAuthRepository,
  InMemoryProviderPublishOperationRepository,
  addDraft,
  addDraftSchema,
  addSource,
  createContentItem,
  recordApproval,
  scheduleTarget,
  type Actor,
  type AuditEvent,
  type ConnectedAccount,
  type OAuthConnectionState,
  type ProviderPublishOperation,
} from "../src/index.js";

const owner: Actor = { id: "owner-1", name: "Owner", role: "owner" };
const now = "2026-08-29T00:00:00.000Z";

describe("Facebook Page first-release contract", () => {
  it("accepts text with no media and a single-image post with one media asset", () => {
    expect(addDraftSchema.safeParse({
      platform: "facebook",
      format: "text",
      title: "Page update",
      caption: "A text-only update",
      mediaIds: [],
    }).success).toBe(true);

    expect(addDraftSchema.safeParse({
      platform: "facebook",
      format: "image",
      title: "Page update",
      caption: "An update with one image",
      mediaIds: ["media-1"],
    }).success).toBe(true);
  });

  it.each(["carousel", "reel", "short"] as const)("rejects the %s format", (format) => {
    const parsed = addDraftSchema.safeParse({
      platform: "facebook",
      format,
      title: "Unsupported Page draft",
      caption: "Caption",
      mediaIds: [],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        path: ["format"],
        message: "Facebook Pages currently support text posts and single-image posts only.",
      }));
    }
  });

  it.each([
    { format: "text", mediaIds: ["media-1"], message: "A Facebook Page text post cannot include media." },
    { format: "image", mediaIds: [], message: "A Facebook Page image post must include exactly one image." },
    { format: "image", mediaIds: ["media-1", "media-2"], message: "A Facebook Page image post must include exactly one image." },
  ] as const)("rejects an invalid $format media count", ({ format, mediaIds, message }) => {
    const parsed = addDraftSchema.safeParse({
      platform: "facebook",
      format,
      title: "Invalid Page draft",
      caption: "Caption",
      mediaIds,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path: ["mediaIds"], message }));
    }
  });

  it("enforces the same rule when a caller bypasses the input schema", () => {
    const { item } = createContentItem({ workspaceId: "workspace-1", brandId: "brand-1", title: "Page update", actor: owner, now });

    expect(() => addDraft(item, {
      platform: "facebook",
      format: "carousel",
      title: "Unsupported Page draft",
      caption: "Caption",
      mediaIds: ["media-1", "media-2"],
    }, owner, now)).toThrow("Facebook Pages currently support text posts and single-image posts only.");
  });

  it("moves an approved single-image Page draft into a Facebook publish target", () => {
    let { item } = createContentItem({ workspaceId: "workspace-1", brandId: "brand-1", title: "Page update", actor: owner, now });
    ({ item } = addSource(item, {
      kind: "url",
      title: "Official source",
      url: "https://example.com/source",
      rights: "reference-only",
      confidence: 95,
    }, owner));
    ({ item } = addDraft(item, {
      platform: "facebook",
      format: "image",
      title: "Page update",
      caption: "Verified update",
      mediaIds: ["media-1"],
    }, owner));
    const draft = item.drafts.at(-1)!;
    ({ item } = recordApproval(item, owner, "approved", "Source checked", draft.id));
    ({ item } = scheduleTarget(item, owner, {
      platform: "facebook",
      accountId: "facebook-page-1",
      draftId: draft.id,
      scheduledFor: "2026-09-01T09:00:00.000Z",
    }, now));

    expect(item.targets.at(-1)).toMatchObject({
      platform: "facebook",
      accountId: "facebook-page-1",
      draftId: draft.id,
      status: "queued",
    });
  });
});

describe("Facebook Page persistence contracts", () => {
  it("stores Facebook Page and Instagram identities as separate connected accounts", async () => {
    const repository = new InMemoryConnectedAccountRepository();
    const base = {
      workspaceId: "workspace-1",
      brandId: "brand-1",
      displayName: "Newsroom",
      externalAccountId: "same-provider-number",
      capabilities: ["profile_read", "media_publish"] as const,
      status: "healthy" as const,
      createdBy: owner.id,
      createdAt: now,
      updatedAt: now,
    };
    const facebook: ConnectedAccount = { ...base, id: "facebook-page-1", platform: "facebook", capabilities: [...base.capabilities] };
    const instagram: ConnectedAccount = { ...base, id: "instagram-1", platform: "instagram", capabilities: [...base.capabilities] };
    const audit = (account: ConnectedAccount): AuditEvent => ({
      id: `audit-${account.id}`,
      workspaceId: account.workspaceId,
      actorId: owner.id,
      actorType: "human",
      action: "channel.account-created",
      detail: { platform: account.platform },
      createdAt: now,
    });

    await repository.save(facebook, audit(facebook));
    await repository.save(instagram, audit(instagram));

    await expect(repository.list("workspace-1", "brand-1")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "facebook-page-1", platform: "facebook" }),
      expect.objectContaining({ id: "instagram-1", platform: "instagram" }),
    ]));
  });

  it("keeps Facebook OAuth state provider-specific and one-time", async () => {
    const repository = new InMemoryOAuthRepository();
    const state: OAuthConnectionState = {
      id: "oauth-facebook-1",
      workspaceId: "workspace-1",
      brandId: "brand-1",
      platform: "facebook",
      actorId: owner.id,
      stateHash: "facebook-state-hash",
      returnUrl: "http://localhost:3000/channels",
      createdAt: now,
      expiresAt: "2026-08-29T00:10:00.000Z",
    };
    await repository.createState(state);

    await expect(repository.consumeState(state.stateHash, "instagram", "2026-08-29T00:01:00.000Z")).resolves.toBeNull();
    await expect(repository.consumeState(state.stateHash, "facebook", "2026-08-29T00:01:00.000Z")).resolves.toMatchObject({
      id: state.id,
      platform: "facebook",
    });
    await expect(repository.consumeState(state.stateHash, "facebook", "2026-08-29T00:02:00.000Z")).resolves.toBeNull();
  });

  it("stores a durable Facebook provider operation without widening analytics", async () => {
    const repository = new InMemoryProviderPublishOperationRepository();
    const operation: ProviderPublishOperation = {
      id: "provider-op-facebook-1",
      workspaceId: "workspace-1",
      contentItemId: "content-1",
      targetId: "target-facebook-1",
      attemptId: "attempt-1",
      platform: "facebook",
      status: "processing",
      containerId: "facebook-operation-1",
      childContainerIds: [],
      createdAt: now,
      updatedAt: now,
    };

    await repository.save(operation);
    await expect(repository.get("workspace-1", operation.targetId)).resolves.toMatchObject({
      platform: "facebook",
      status: "processing",
      containerId: "facebook-operation-1",
    });
  });
});
