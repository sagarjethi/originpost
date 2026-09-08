import { type AuditEvent, type AuthUser, type WorkspaceInvitation } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAuthRepository } from "../src/postgres-auth-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-invitation-integration";
const otherWorkspaceId = "workspace-invitation-existing-home";
const ownerId = "invitation-integration-owner";
const at = "2026-09-07T10:00:00.000Z";

suite("Postgres workspace invitations", () => {
  const sql = postgres(databaseUrl!);
  const repository = new PostgresAuthRepository(sql);

  function event(id: string, invitationId: string, actorId: string, action: string, createdAt = at): AuditEvent {
    return { id, workspaceId, actorId, actorType: "human", action, detail: { invitationId }, createdAt };
  }

  function invitation(id: string, email: string, tokenSha256: string): WorkspaceInvitation {
    return { id, workspaceId, workspaceName: "Invitation Integration", workspaceSlug: "invitation-integration", email, role: "creator", status: "pending", deliveryState: "link_ready", tokenSha256, expiresAt: "2026-09-14T10:00:00.000Z", invitedBy: ownerId, createdAt: at, updatedAt: at };
  }

  beforeAll(async () => {
    await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${workspaceId},'Invitation Integration','invitation-integration',${at},${at}) on conflict(id) do nothing`;
    await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${otherWorkspaceId},'Existing Home','existing-home',${at},${at}) on conflict(id) do nothing`;
    await sql`insert into auth_users(id,email,display_name,password_hash,status,created_at,updated_at) values(${ownerId},'invite-owner@example.test','Invitation Owner','hash','active',${at},${at}) on conflict(id) do nothing`;
    await sql`insert into workspace_members(workspace_id,user_id,display_name,role,created_at,updated_at) values(${workspaceId},${ownerId},'Invitation Owner','owner',${at},${at}) on conflict(workspace_id,user_id) do nothing`;
  });

  afterAll(async () => {
    await sql`delete from workspace_invitations where workspace_id in (${workspaceId},${otherWorkspaceId})`;
    await sql`delete from audit_events where workspace_id in (${workspaceId},${otherWorkspaceId})`;
    await sql`delete from auth_sessions where user_id in (select id from auth_users where email like '%@invitation.test')`;
    await sql`delete from workspace_members where workspace_id in (${workspaceId},${otherWorkspaceId})`;
    await sql`delete from auth_users where id=${ownerId} or email like '%@invitation.test'`;
    await sql`delete from workspaces where id in (${workspaceId},${otherWorkspaceId})`;
    await sql.end();
  });

  it("enforces one active invitation, rotates its token, and revokes it atomically with audit", async () => {
    const initial = invitation("invite-postgres-lifecycle", "lifecycle@invitation.test", "a".repeat(64));
    await repository.createWorkspaceInvitation(initial, event("audit-invite-create", initial.id, ownerId, "workspace.invitation-created"));
    await expect(repository.createWorkspaceInvitation({ ...initial, id: "invite-postgres-duplicate", tokenSha256: "b".repeat(64) }, event("audit-invite-duplicate", "invite-postgres-duplicate", ownerId, "workspace.invitation-created"))).rejects.toMatchObject({ code: "workspace_invitation_exists" });
    const rotated = await repository.resendWorkspaceInvitation(workspaceId, initial.id, "c".repeat(64), "2026-09-20T10:00:00.000Z", "2026-09-08T10:00:00.000Z", event("audit-invite-resend", initial.id, ownerId, "workspace.invitation-resent", "2026-09-08T10:00:00.000Z"));
    expect(rotated).toMatchObject({ tokenSha256: "c".repeat(64), status: "pending", deliveryState: "link_ready" });
    await expect(repository.getWorkspaceInvitationByTokenSha256("a".repeat(64), "2026-09-08T10:01:00.000Z")).resolves.toBeNull();
    await expect(repository.revokeWorkspaceInvitation(workspaceId, initial.id, ownerId, "2026-09-08T10:02:00.000Z", event("audit-invite-revoke", initial.id, ownerId, "workspace.invitation-revoked", "2026-09-08T10:02:00.000Z"))).resolves.toMatchObject({ status: "revoked" });
    expect(await sql<{ count: number }[]>`select count(*)::int as count from audit_events where workspace_id=${workspaceId} and detail->>'invitationId'=${initial.id}`).toEqual([{ count: 3 }]);
  });

  it("creates a new user and exact membership once without putting its token in audit", async () => {
    const pending = invitation("invite-postgres-new", "new-user@invitation.test", "d".repeat(64));
    await repository.createWorkspaceInvitation(pending, event("audit-invite-new-create", pending.id, ownerId, "workspace.invitation-created"));
    const acceptedAt = "2026-09-08T11:00:00.000Z";
    const newUser: AuthUser = { id: "invitation-new-user", email: pending.email, displayName: "New User", passwordHash: "password-hash", status: "active", createdAt: acceptedAt, updatedAt: acceptedAt };
    await expect(repository.acceptWorkspaceInvitation({ tokenSha256: pending.tokenSha256, acceptedAt, newUser, event: event("audit-invite-new-accept", pending.id, newUser.id, "workspace.invitation-accepted", acceptedAt) })).resolves.toMatchObject({ invitation: { status: "accepted", acceptedBy: newUser.id }, member: { email: pending.email, role: "creator" } });
    await expect(repository.acceptWorkspaceInvitation({ tokenSha256: pending.tokenSha256, acceptedAt: "2026-09-08T11:01:00.000Z", existingUserId: newUser.id, event: event("audit-invite-new-replay", pending.id, newUser.id, "workspace.invitation-accepted", "2026-09-08T11:01:00.000Z") })).rejects.toMatchObject({ code: "workspace_invitation_unavailable" });
    const audit = await sql<{ text: string }[]>`select detail::text as text from audit_events where workspace_id=${workspaceId} and detail->>'invitationId'=${pending.id}`;
    expect(JSON.stringify(audit)).not.toContain(pending.tokenSha256);
    expect(await repository.getMembership(workspaceId, newUser.id)).toMatchObject({ role: "creator" });
  });

  it("adds an existing matching account to a second workspace and rejects a mismatched session", async () => {
    const existing: AuthUser = { id: "invitation-existing-user", email: "existing-user@invitation.test", displayName: "Existing User", passwordHash: "password-hash", status: "active", createdAt: at, updatedAt: at };
    await sql`insert into auth_users(id,email,display_name,password_hash,status,created_at,updated_at) values(${existing.id},${existing.email},${existing.displayName},${existing.passwordHash},${existing.status},${existing.createdAt},${existing.updatedAt})`;
    await sql`insert into workspace_members(workspace_id,user_id,display_name,role,created_at,updated_at) values(${otherWorkspaceId},${existing.id},${existing.displayName},'viewer',${at},${at})`;
    const pending = invitation("invite-postgres-existing", existing.email, "e".repeat(64));
    await repository.createWorkspaceInvitation(pending, event("audit-invite-existing-create", pending.id, ownerId, "workspace.invitation-created"));
    await expect(repository.acceptWorkspaceInvitation({ tokenSha256: pending.tokenSha256, acceptedAt: "2026-09-08T12:00:00.000Z", existingUserId: ownerId, event: event("audit-invite-existing-wrong", pending.id, ownerId, "workspace.invitation-accepted", "2026-09-08T12:00:00.000Z") })).rejects.toMatchObject({ code: "workspace_invitation_email_mismatch" });
    expect(await repository.getWorkspaceInvitationByTokenSha256(pending.tokenSha256, "2026-09-08T12:01:00.000Z")).toMatchObject({ status: "pending" });
    await expect(repository.acceptWorkspaceInvitation({ tokenSha256: pending.tokenSha256, acceptedAt: "2026-09-08T12:02:00.000Z", existingUserId: existing.id, event: event("audit-invite-existing-accept", pending.id, existing.id, "workspace.invitation-accepted", "2026-09-08T12:02:00.000Z") })).resolves.toMatchObject({ member: { workspaceId, userId: existing.id, role: "creator" } });
  });
});
