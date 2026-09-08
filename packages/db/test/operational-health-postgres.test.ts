import { createNotification } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresNotificationRepository } from "../src/postgres-notification-repository.js";
import { PostgresOperationalIncidentRepository } from "../src/postgres-operational-incident-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-operations-health-integration";
const at = "2026-09-08T10:00:00.000Z";

suite("Postgres operational health", () => {
  const sql = postgres(databaseUrl!);
  const incidents = new PostgresOperationalIncidentRepository(sql);
  const notifications = new PostgresNotificationRepository(sql);

  beforeAll(async () => {
    await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${workspaceId},'Operations Health','operations-health-integration',${at},${at}) on conflict(id) do nothing`;
  });

  afterAll(async () => {
    await sql`delete from workspace_notifications where workspace_id=${workspaceId}`;
    await sql`delete from workspace_operational_incidents where workspace_id=${workspaceId}`;
    await sql`delete from workspaces where id=${workspaceId}`;
    await sql.end();
  });

  it("atomically records incident transitions and reopens a resolved check", async () => {
    const base = { workspaceId, checkId: "malware_protection" as const };
    await expect(incidents.observe({ ...base, status: "error", fingerprint: "a".repeat(64), observedAt: at })).resolves.toMatchObject({ transition: "opened" });
    await expect(incidents.observe({ ...base, status: "error", fingerprint: "a".repeat(64), observedAt: "2026-09-08T10:05:00.000Z" })).resolves.toMatchObject({ transition: "unchanged" });
    await expect(incidents.observe({ ...base, observedAt: "2026-09-08T10:10:00.000Z" })).resolves.toMatchObject({ transition: "resolved" });
    await expect(incidents.observe({ ...base, status: "error", fingerprint: "a".repeat(64), observedAt: "2026-09-08T11:00:00.000Z" })).resolves.toMatchObject({ transition: "opened", incident: { openedAt: "2026-09-08T11:00:00.000Z" } });
  });

  it("hides operator alerts from workspace readers at query and mutation boundaries", async () => {
    const operator = createNotification({ workspaceId, kind: "system", severity: "error", title: "Operator alert", body: "Protected operations detail.", dedupeKey: "operator-alert", audience: "operators", now: at });
    const workspace = createNotification({ workspaceId, kind: "system", severity: "info", title: "Workspace alert", body: "Visible workspace detail.", dedupeKey: "workspace-alert", now: at });
    await notifications.create(operator); await notifications.create(workspace);
    await expect(notifications.list(workspaceId)).resolves.toEqual([expect.objectContaining({ id: workspace.id })]);
    await expect(notifications.countUnread(workspaceId)).resolves.toBe(1);
    await expect(notifications.markRead(workspaceId, operator.id, "viewer", at)).resolves.toBeNull();
    await expect(notifications.list(workspaceId, { includeOperatorAlerts: true })).resolves.toHaveLength(2);
    await expect(notifications.countUnread(workspaceId, { includeOperatorAlerts: true })).resolves.toBe(2);
  });
});
