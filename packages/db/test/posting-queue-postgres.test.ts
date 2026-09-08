import { addDraft, addSource, createAccountPostingQueueProfile, createContentItem, markTargetStatus, postingQueueRequestSha256, recordApproval, rescheduleTarget, type Actor, type ConnectedAccount, type ContentItem } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresConnectedAccountRepository } from "../src/postgres-connected-account-repository.js";
import { PostgresPostingQueueRepository } from "../src/postgres-posting-queue-repository.js";
import { PostgresContentItemRepository } from "../src/postgres-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-posting-queue-integration";
const brandId = "brand-posting-queue-integration";
const accountId = "account-posting-queue-integration";
const owner: Actor = { id: "queue-integration-owner", name: "Queue Owner", role: "owner" };
const at = "2026-09-01T10:00:00.000Z";

suite("Postgres account posting queues", () => {
  const sql = postgres(databaseUrl!);
  const content = new PostgresContentItemRepository(sql);
  const accounts = new PostgresConnectedAccountRepository(sql);
  const queues = new PostgresPostingQueueRepository(sql);
  const account: ConnectedAccount = { id: accountId, workspaceId, brandId, platform: "facebook", displayName: "Queue Page", externalAccountId: "queue-page", capabilities: ["page_read", "media_publish"], status: "healthy", createdBy: owner.id, createdAt: at, updatedAt: at };

  beforeAll(async () => {
    await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${workspaceId},'Posting Queue Integration','posting-queue-integration',${at},${at}) on conflict(id) do nothing`;
    await sql`insert into brands(id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values(${brandId},${workspaceId},'Queue brand','queue-brand','English','UTC','active',${owner.id},${at},${at}) on conflict(id) do nothing`;
    await accounts.save(account, { id: "audit-posting-queue-account", workspaceId, actorId: owner.id, actorType: "human", action: "test.account-created", detail: {}, createdAt: at });
    const weeklySlots = { monday: ["22:00", "23:30"], tuesday: ["22:00", "23:30"], wednesday: ["22:00", "23:30"], thursday: ["22:00", "23:30"], friday: ["22:00", "23:30"], saturday: ["22:00", "23:30"], sunday: ["22:00", "23:30"] };
    const made = createAccountPostingQueueProfile({ workspaceId, brandId, account, enabled: true, timezone: "UTC", weeklySlots, expectedVersion: 0, actor: owner, now: at });
    await queues.saveProfile(made.profile, made.event, 0);
  });

  afterAll(async () => {
    await sql`delete from outbox_events where workspace_id=${workspaceId}`;
    await sql`delete from posting_queue_reservations where workspace_id=${workspaceId}`;
    await sql`delete from publish_targets where workspace_id=${workspaceId}`;
    await sql`delete from account_posting_queue_profiles where workspace_id=${workspaceId}`;
    await sql`delete from audit_events where workspace_id=${workspaceId}`;
    await sql`delete from content_items where workspace_id=${workspaceId}`;
    await sql`delete from connected_accounts where workspace_id=${workspaceId}`;
    await sql`delete from brands where workspace_id=${workspaceId}`;
    await sql`delete from workspaces where id=${workspaceId}`;
    await sql.end();
  });

  async function approvedItem(id: string): Promise<ContentItem> {
    let result = createContentItem({ contentId: id, workspaceId, brandId, title: id, summary: "Queue integration", actor: owner });
    await content.commit(result.item, result.event); let item = result.item;
    result = addSource(item, { kind: "url", title: "Source", url: `https://example.com/${id}`, rights: "reference-only", confidence: 95 }, owner, at); await content.commit(result.item, result.event); item = result.item;
    result = addDraft(item, { platform: "facebook", format: "text", title: id, caption: `${id} caption`, mediaIds: [] }, owner, at); await content.commit(result.item, result.event); item = result.item;
    result = recordApproval(item, owner, "approved", "ready", item.drafts[0]!.id, at); await content.commit(result.item, result.event); return result.item;
  }

  it("locks one account profile and gives concurrent commands distinct exact slots", async () => {
    const [left, right] = await Promise.all([approvedItem("content-posting-queue-left"), approvedItem("content-posting-queue-right")]);
    const command = (item: ContentItem, idempotencyKey: string) => ({ workspaceId, brandId, contentItemId: item.id, expectedContentVersion: item.version, expectedProfileVersion: 1, idempotencyKey, requestSha256: postingQueueRequestSha256({ item: item.id, idempotencyKey }), actor: owner, schedule: { platform: "facebook" as const, accountId, draftId: item.drafts[0]!.id, deliveryMode: "manual_handoff" as const } });
    const [first, second] = await Promise.all([queues.scheduleNext(command(left, "posting-queue-integration-left")), queues.scheduleNext(command(right, "posting-queue-integration-right"))]);
    expect(first.target.scheduledFor).not.toBe(second.target.scheduledFor);
    expect(new Set([first.target.queueAssignment?.localTime, second.target.queueAssignment?.localTime])).toEqual(new Set(["22:00", "23:30"]));
    expect(await sql<{ count: number }[]>`select count(*)::int as count from posting_queue_reservations where workspace_id=${workspaceId} and released_at is null`).toEqual([{ count: 2 }]);
    expect(await sql<{ count: number }[]>`select count(*)::int as count from outbox_events where workspace_id=${workspaceId} and topic='publish.target.requested'`).toEqual([{ count: 2 }]);
    const due = markTargetStatus(second.item, second.target.id, "action_required", { id: "posting-queue-worker", name: "Posting Queue Worker", role: "owner" }, { deliveryMode: "manual_handoff" });
    await expect(content.commit(due.item, due.event)).resolves.toBeUndefined();
    expect(await sql<{ status: string }[]>`select status from publish_targets where workspace_id=${workspaceId} and id=${second.target.id}`).toEqual([{ status: "action_required" }]);
    expect(await sql<{ count: number }[]>`select count(*)::int as count from posting_queue_reservations where workspace_id=${workspaceId} and target_id=${second.target.id}`).toEqual([{ count: 1 }]);
    const moved = rescheduleTarget(first.item, first.target.id, { scheduledFor: "2099-09-01T12:00:00.000Z", timezone: "UTC" }, owner, new Date().toISOString());
    const draft = moved.item.drafts.find((entry) => entry.id === moved.target.draftId)!;
    await expect(queues.commitReschedule(moved.item, moved.event, first.target.id, moved.target, owner.id, { request: { workspaceId, brandId, contentItemId: moved.item.id, draftId: draft.id, draftSha256: draft.contentSha256, platform: moved.target.platform, accountId: moved.target.accountId, scheduledFor: moved.target.scheduledFor, excludeTargetId: first.target.id } })).resolves.toBe(true);
    expect(moved.target.queueAssignment).toBeUndefined();
    expect(await sql<{ count: number }[]>`select count(*)::int as count from posting_queue_reservations where workspace_id=${workspaceId} and released_at is null`).toEqual([{ count: 1 }]);
    expect(await sql<{ payload: { queueAssignment?: unknown } }[]>`select payload from publish_targets where workspace_id=${workspaceId} and id=${moved.target.id}`).toEqual([{ payload: expect.not.objectContaining({ queueAssignment: expect.anything() }) }]);
  });
});
