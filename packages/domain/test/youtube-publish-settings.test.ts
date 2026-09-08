import { describe, expect, it } from "vitest";
import {
  addDraft,
  addSource,
  createContentItem,
  confirmProviderPublication,
  markTargetStatus,
  recordApproval,
  scheduleSchema,
  scheduleTarget,
  startPublishAttempt,
  type Actor,
} from "../src/index.js";

const owner: Actor = { id: "owner-1", name: "Owner", role: "owner" };
const beforeScheduledPublish = "2026-08-29T09:00:00.000Z";

const settings = {
  title: "A checked YouTube Short",
  description: "A checked description.",
  madeForKids: false,
  containsSyntheticMedia: false,
};

describe("YouTube publish settings", () => {
  it("normalizes safe defaults and preserves the editor time zone", () => {
    const parsed = scheduleSchema.parse({
      platform: "youtube",
      accountId: "youtube-1",
      draftId: "draft-1",
      scheduledFor: "2026-09-01T09:00:00.000Z",
      settings: { ...settings, timezone: "Asia/Kolkata" },
    });

    expect(parsed.settings).toMatchObject({ privacyStatus: "private", notifySubscribers: false, timezone: "Asia/Kolkata" });
  });

  it("requires the audience and synthetic-media declarations", () => {
    const parsed = scheduleSchema.safeParse({
      platform: "youtube",
      accountId: "youtube-1",
      draftId: "draft-1",
      scheduledFor: "2026-09-01T09:00:00.000Z",
      settings: { title: settings.title, description: settings.description },
    });

    expect(parsed.success).toBe(false);
  });

  it("blocks provider-invalid text, byte limits, and time zones", () => {
    const base = {
      platform: "youtube" as const,
      accountId: "youtube-1",
      draftId: "draft-1",
      scheduledFor: "2026-09-01T09:00:00.000Z",
    };

    expect(scheduleSchema.safeParse({ ...base, settings: { ...settings, title: "Bad <title>" } }).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...base, settings: { ...settings, description: "🙂".repeat(1_251) } }).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...base, settings: { ...settings, timezone: "Mars/Olympus" } }).success).toBe(false);
  });

  it("does not change the existing Instagram scheduling shape", () => {
    expect(scheduleSchema.parse({
      platform: "instagram",
      accountId: "instagram-1",
      draftId: "draft-1",
      scheduledFor: "2026-09-01T09:00:00.000Z",
    })).toEqual({
      platform: "instagram",
      accountId: "instagram-1",
      draftId: "draft-1",
      scheduledFor: "2026-09-01T09:00:00.000Z",
      deliveryMode: "auto_publish",
    });
  });

  it("stores YouTube settings and their safety choices in the audit event", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: settings.title, actor: owner });
    ({ item } = addSource(item, { kind: "url", title: "Official source", url: "https://example.com/youtube", rights: "reference-only", confidence: 95 }, owner));
    ({ item } = addDraft(item, { platform: "youtube", format: "short", title: settings.title, caption: settings.description, mediaIds: ["video-1"] }, owner));
    const draft = item.drafts.at(-1)!;
    ({ item } = recordApproval(item, owner, "approved", "Checked", draft.id));
    const scheduled = scheduleTarget(item, owner, {
      platform: "youtube",
      accountId: "youtube-1",
      draftId: draft.id,
      scheduledFor: "2026-09-01T09:00:00.000Z",
      settings: { ...settings, privacyStatus: "private", notifySubscribers: false, timezone: "Asia/Kolkata" },
    }, beforeScheduledPublish);

    expect(scheduled.item.targets.at(-1)?.settings).toMatchObject(settings);
    expect(scheduled.event.detail).toMatchObject({
      platform: "youtube",
      privacyStatus: "private",
      madeForKids: false,
      containsSyntheticMedia: false,
      notifySubscribers: false,
      timezone: "Asia/Kolkata",
    });
  });

  it("keeps reconciled automatic proof aligned with the approved synthetic-media declaration", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: settings.title, actor: owner });
    ({ item } = addSource(item, { kind: "url", title: "Official source", url: "https://example.com/youtube-proof", rights: "reference-only", confidence: 95 }, owner));
    ({ item } = addDraft(item, { platform: "youtube", format: "short", title: settings.title, caption: settings.description, mediaIds: ["video-1"] }, owner));
    const draft = item.drafts.at(-1)!;
    ({ item } = recordApproval(item, owner, "approved", "Checked", draft.id));
    ({ item } = scheduleTarget(item, owner, {
      platform: "youtube",
      accountId: "youtube-1",
      draftId: draft.id,
      scheduledFor: "2026-09-01T09:00:00.000Z",
      settings: { ...settings, privacyStatus: "private", containsSyntheticMedia: true, notifySubscribers: false },
    }, beforeScheduledPublish));
    const target = item.targets.at(-1)!;
    ({ item } = startPublishAttempt(item, target.id, `publish:${target.id}:v1`, owner));
    ({ item } = markTargetStatus(item, target.id, "action_required", owner));
    ({ item } = confirmProviderPublication(item, target.id, {
      providerOperationId: "operation-1",
      externalPostId: "video-1",
      liveUrl: "https://www.youtube.com/watch?v=video-1",
      publishedAt: "2026-09-01T09:05:00.000Z",
      mediaSha256: ["a".repeat(64)],
      disclosure: "none",
    }, owner));

    expect(item.proofs.at(-1)?.disclosure).toBe("synthetic-media");
  });
});
