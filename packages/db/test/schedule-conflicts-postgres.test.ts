import { addDraft, addSource, createContentItem, recordApproval, scheduleTarget, type Actor, type ContentItem, type ScheduleConflictCommit } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresContentItemRepository } from "../src/postgres-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-schedule-conflict-integration";
const brandId = "brand-schedule-conflict-integration";
const accountId = "account-schedule-conflict-integration";
const owner: Actor = { id: "schedule-conflict-owner", name: "Conflict Owner", role: "owner" };
const at = "2026-09-01T10:00:00.000Z";
const scheduledFor = "2099-09-02T10:00:00.000Z";

suite("Postgres schedule conflict serialization", () => {
  const sql = postgres(databaseUrl!);
  const repository = new PostgresContentItemRepository(sql);

  beforeAll(async () => {
    await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${workspaceId},'Schedule conflict integration','schedule-conflict-integration',${at},${at}) on conflict(id) do nothing`;
    await sql`insert into brands(id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values(${brandId},${workspaceId},'Schedule conflict brand','schedule-conflict-brand','English','UTC','active',${owner.id},${at},${at}) on conflict(id) do nothing`;
  });

  afterAll(async () => {
    await sql`delete from outbox_events where workspace_id=${workspaceId}`;
    await sql`delete from publish_targets where workspace_id=${workspaceId}`;
    await sql`delete from audit_events where workspace_id=${workspaceId}`;
    await sql`delete from content_items where workspace_id=${workspaceId}`;
    await sql`delete from brands where workspace_id=${workspaceId}`;
    await sql`delete from workspaces where id=${workspaceId}`;
    await sql.end();
  });

  async function approvedItem(id: string): Promise<ContentItem> {
    let result = createContentItem({ contentId: id, workspaceId, brandId, title: id, summary: "Conflict integration", actor: owner }, at);
    await repository.commit(result.item, result.event); let item = result.item;
    result = addSource(item, { kind: "url", title: "Source", url: `https://example.com/${id}`, rights: "reference-only", confidence: 95 }, owner, at); await repository.commit(result.item, result.event); item = result.item;
    result = addDraft(item, { platform: "facebook", format: "text", title: "Identical approved copy", caption: "One exact approved caption", mediaIds: [] }, owner, at); await repository.commit(result.item, result.event); item = result.item;
    result = recordApproval(item, owner, "approved", "ready", item.drafts[0]!.id, at); await repository.commit(result.item, result.event); return result.item;
  }

  it("serializes same-account writes so one unacknowledged concurrent duplicate is rejected", async () => {
    const [left, right] = await Promise.all([approvedItem("content-conflict-left"), approvedItem("content-conflict-right")]);
    const scheduled = [left, right].map((item) => scheduleTarget(item, owner, { platform: "facebook", accountId, draftId: item.drafts[0]!.id, scheduledFor, deliveryMode: "manual_handoff" }, at));
    const commit = (result: (typeof scheduled)[number]): Promise<void> => {
      const draft = result.item.drafts[0]!;
      const scheduleConflict: ScheduleConflictCommit = { request: { workspaceId, brandId, contentItemId: result.item.id, draftId: draft.id, draftSha256: draft.contentSha256, platform: "facebook", accountId, scheduledFor } };
      return repository.commit(result.item, result.event, [], [], [], scheduleConflict);
    };

    const outcomes = await Promise.allSettled(scheduled.map(commit));
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "schedule_conflict_confirmation_required", statusCode: 409 });
    expect(await sql<{ count: number }[]>`select count(*)::int as count from publish_targets where workspace_id=${workspaceId} and account_id=${accountId} and status='queued'`).toEqual([{ count: 1 }]);
  });
});
