import { describe, expect, it } from "vitest";
import { addDraft, addSource, createAccountPostingQueueProfile, createContentItem, InMemoryContentItemRepository, InMemoryPostingQueueRepository, recordApproval, rescheduleTarget, resolvePostingQueue, scheduleTargetFromQueue, transition, type AccountPostingQueueProfile, type Actor, type ConnectedAccount, type ContentItem, type PostingQueueSlots } from "../src/index.js";

const owner: Actor = { id: "owner", name: "Owner", role: "owner" };
const creator: Actor = { id: "creator", name: "Creator", role: "creator" };
const slots = (overrides: Partial<PostingQueueSlots> = {}): PostingQueueSlots => ({ monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [], ...overrides });
const profile = (timezone: string, weeklySlots: PostingQueueSlots): AccountPostingQueueProfile => ({ id: "profile-1", workspaceId: "workspace-1", brandId: "brand-1", connectedAccountId: "account-1", platform: "instagram", enabled: true, timezone, weeklySlots, version: 1, createdBy: "owner", updatedBy: "owner", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });

describe("account posting queues", () => {
  it("skips spring-forward gaps and chooses the earlier fall-back occurrence", () => {
    const spring = resolvePostingQueue(profile("America/New_York", slots({ sunday: ["02:30"] })), "2026-03-07T12:00:00.000Z", new Set(), 1);
    expect(spring.skipped).toContainEqual({ localDate: "2026-03-08", localTime: "02:30", reason: "dst_gap_skipped" });
    expect(spring.occurrences[0]?.localDate).toBe("2026-03-15");
    const fall = resolvePostingQueue(profile("America/New_York", slots({ sunday: ["01:30"] })), "2026-10-31T12:00:00.000Z", new Set(), 1);
    expect(fall.occurrences[0]).toMatchObject({ localDate: "2026-11-01", utcOffset: "-04:00", notes: ["dst_ambiguous_earlier_offset"] });
  });

  it("keeps occupancy account-scoped and allocates concurrent requests to different slots", async () => {
    const content = new InMemoryContentItemRepository();
    const clock = () => new Date("2026-09-06T00:00:00.000Z");
    const queues = new InMemoryPostingQueueRepository(content, clock);
    const account: ConnectedAccount = { id: "account-1", workspaceId: "workspace-1", brandId: "brand-1", platform: "instagram", displayName: "IG", externalAccountId: "ig", capabilities: ["media_publish"], status: "healthy", createdBy: "owner", createdAt: clock().toISOString(), updatedAt: clock().toISOString() };
    const made = createAccountPostingQueueProfile({ workspaceId: "workspace-1", brandId: "brand-1", account, enabled: true, timezone: "UTC", weeklySlots: slots({ monday: ["09:00", "10:00"] }), expectedVersion: 0, actor: owner, now: clock().toISOString() });
    await queues.saveProfile(made.profile, made.event, 0);
    async function approvedItem(id: string) {
      async function commit(result: { item: ContentItem; event: Parameters<InMemoryContentItemRepository["commit"]>[1] }) {
        await content.commit(result.item, result.event);
        return result.item;
      }
      let item = await commit(createContentItem({ contentId: id, workspaceId: "workspace-1", brandId: "brand-1", title: id, summary: "summary", actor: owner }));
      item = await commit(addSource(item, { kind: "url", title: "Source", url: `https://example.com/${id}`, rights: "reference-only", confidence: 95 }, owner, clock().toISOString()));
      item = await commit(addDraft(item, { platform: "instagram", format: "image", title: id, caption: "caption", mediaIds: [] }, owner, clock().toISOString()));
      item = await commit(transition(item, "review", owner, "review", clock().toISOString()));
      item = await commit(recordApproval(item, owner, "approved", "ready", item.drafts[0]!.id, clock().toISOString()));
      return item;
    }
    const [left, right] = await Promise.all([approvedItem("content-left"), approvedItem("content-right")]);
    const base = (item: typeof left, key: string) => ({ workspaceId: item.workspaceId, brandId: item.brandId, contentItemId: item.id, expectedContentVersion: item.version, expectedProfileVersion: 1, idempotencyKey: key, requestSha256: key.padEnd(64, "0").slice(0, 64), actor: creator, schedule: { platform: "instagram" as const, accountId: account.id, draftId: item.drafts[0]!.id, deliveryMode: "manual_handoff" as const } });
    const [first, second] = await Promise.all([queues.scheduleNext(base(left, "request-a")), queues.scheduleNext(base(right, "request-b"))]);
    expect([first.target.scheduledFor, second.target.scheduledFor].sort()).toEqual(["2026-09-07T09:00:00.000Z", "2026-09-07T10:00:00.000Z"]);
    const moved = rescheduleTarget(first.item, first.target.id, { scheduledFor: "2026-09-08T12:00:00.000Z", timezone: "UTC" }, owner, "2026-09-06T00:01:00.000Z");
    expect(moved.target.queueAssignment).toBeUndefined();
    expect(moved.event.detail).toMatchObject({ releasedQueueReservationId: first.reservation.id });
    const replay = await queues.scheduleNext(base(left, "request-a"));
    expect(replay.replayed).toBe(true);
    expect(replay.target.id).toBe(first.target.id);
  });

  it("allows a creator only through the queue-specific scheduling command", () => {
    let item = createContentItem({ workspaceId: "workspace-1", brandId: "brand-1", title: "Approved", summary: "summary", actor: owner }).item;
    item = addSource(item, { kind: "url", title: "Source", url: "https://example.com/approved", rights: "reference-only", confidence: 95 }, owner, "2026-09-01T00:00:00.000Z").item;
    item = addDraft(item, { platform: "facebook", format: "text", title: "Approved", caption: "caption", mediaIds: [] }, owner, "2026-09-01T00:00:00.000Z").item;
    item = transition(item, "review", owner, "review", "2026-09-01T00:01:00.000Z").item;
    item = recordApproval(item, owner, "approved", "ready", item.drafts[0]!.id, "2026-09-01T00:02:00.000Z").item;
    expect(scheduleTargetFromQueue(item, creator, { platform: "facebook", accountId: "facebook-1", draftId: item.drafts[0]!.id, scheduledFor: "2026-09-02T09:00:00.000Z", deliveryMode: "manual_handoff" }, "2026-09-01T00:03:00.000Z").item.targets).toHaveLength(1);
  });
});
