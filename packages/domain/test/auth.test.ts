import { describe, expect, it } from "vitest";
import { InMemoryAuthRepository, type AuditEvent, type AuthUser, type WorkspaceInvitation, type WorkspaceMembership } from "../src/index.js";

function fixture(id: string, email: string, role: WorkspaceMembership["role"], time = "2026-08-29T00:00:00.000Z") {
  const user: AuthUser = { id, email, displayName: id, passwordHash: "hash", status: "active", createdAt: time, updatedAt: time };
  const membership: WorkspaceMembership = { workspaceId: "default", workspaceName: "My workspace", workspaceSlug: "my-workspace", userId: id, role, createdAt: time, updatedAt: time };
  return { user, membership, createdBy: id };
}

describe("InMemoryAuthRepository", () => {
  it("normalizes lookup, scopes membership, and rejects duplicate email", async () => {
    const repository = new InMemoryAuthRepository();
    await repository.createUserWithMembership(fixture("owner", "owner@example.com", "owner"));
    await expect(repository.findUserByEmail(" OWNER@example.com ")).resolves.toMatchObject({ id: "owner" });
    await expect(repository.getMembership("other", "owner")).resolves.toBeNull();
    await expect(repository.createUserWithMembership(fixture("second", "owner@example.com", "viewer"))).rejects.toMatchObject({ code: "user_email_exists", statusCode: 409 });
  });

  it("keeps at least one owner and allows role changes after adding another", async () => {
    const repository = new InMemoryAuthRepository();
    await repository.createUserWithMembership(fixture("owner", "owner@example.com", "owner"));
    await expect(repository.updateMembershipRole("default", "owner", "manager", "owner", "2026-08-29T00:01:00.000Z")).rejects.toMatchObject({ code: "last_owner_required", statusCode: 409 });
    await repository.createUserWithMembership(fixture("owner-2", "owner2@example.com", "owner"));
    await expect(repository.updateMembershipRole("default", "owner", "manager", "owner-2", "2026-08-29T00:02:00.000Z")).resolves.toMatchObject({ role: "manager" });
  });

  it("does not expose or count disabled legacy members", async () => {
    const repository = new InMemoryAuthRepository();
    const legacy = fixture("legacy", "legacy@example.com", "owner");
    legacy.user.status = "disabled";
    await repository.createUserWithMembership(legacy);
    await repository.createUserWithMembership(fixture("owner", "owner@example.com", "owner"));
    await expect(repository.listWorkspaceMembers("default")).resolves.toEqual([expect.objectContaining({ userId: "owner" })]);
    await expect(repository.updateMembershipRole("default", "owner", "manager", "owner", "2026-08-29T00:01:00.000Z")).rejects.toMatchObject({ code: "last_owner_required" });
  });

  it("keeps invitations pending until one exact email-bound acceptance", async () => {
    const repository = new InMemoryAuthRepository();
    const owner = fixture("owner", "owner@example.com", "owner");
    await repository.createUserWithMembership(owner);
    const invitation: WorkspaceInvitation = {
      id: "invite-1", workspaceId: "default", workspaceName: "My workspace", workspaceSlug: "my-workspace", email: "member@example.com", role: "manager",
      status: "pending", deliveryState: "link_ready", tokenSha256: "a".repeat(64), expiresAt: "2026-09-14T00:00:00.000Z", invitedBy: owner.user.id,
      createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
    };
    const event = (action: string, actorId: string, at: string): AuditEvent => ({ id: `${action}-${actorId}`, workspaceId: "default", actorId, actorType: "human", action, detail: { invitationId: invitation.id }, createdAt: at });
    await repository.createWorkspaceInvitation(invitation, event("workspace.invitation-created", owner.user.id, invitation.createdAt));
    await expect(repository.createWorkspaceInvitation({ ...invitation, id: "invite-2", tokenSha256: "b".repeat(64) }, event("workspace.invitation-created", owner.user.id, invitation.createdAt))).rejects.toMatchObject({ code: "workspace_invitation_exists" });
    const newUser: AuthUser = { id: "member", email: invitation.email, displayName: "Member", passwordHash: "hash", status: "active", createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z" };
    const accepted = await repository.acceptWorkspaceInvitation({ tokenSha256: invitation.tokenSha256, acceptedAt: newUser.createdAt, newUser, event: event("workspace.invitation-accepted", newUser.id, newUser.createdAt) });
    expect(accepted).toMatchObject({ invitation: { status: "accepted", acceptedBy: newUser.id }, member: { workspaceId: "default", role: "manager", email: invitation.email } });
    await expect(repository.acceptWorkspaceInvitation({ tokenSha256: invitation.tokenSha256, acceptedAt: "2026-09-08T00:01:00.000Z", existingUserId: newUser.id, event: event("workspace.invitation-accepted", newUser.id, "2026-09-08T00:01:00.000Z") })).rejects.toMatchObject({ code: "workspace_invitation_unavailable" });
  });

  it("rotates an expired invitation token and lets only the matching signed-in user join", async () => {
    const repository = new InMemoryAuthRepository();
    const owner = fixture("owner", "owner@example.com", "owner");
    const existing = fixture("existing", "member@example.com", "viewer");
    existing.membership.workspaceId = "other"; existing.membership.workspaceName = "Other"; existing.membership.workspaceSlug = "other";
    await repository.createUserWithMembership(owner);
    await repository.createUserWithMembership(existing);
    const invitation: WorkspaceInvitation = { id: "invite-expired", workspaceId: "default", workspaceName: "My workspace", workspaceSlug: "my-workspace", email: existing.user.email, role: "creator", status: "pending", deliveryState: "link_ready", tokenSha256: "c".repeat(64), expiresAt: "2026-09-08T00:00:00.000Z", invitedBy: owner.user.id, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z" };
    const audit: AuditEvent = { id: "audit", workspaceId: "default", actorId: owner.user.id, actorType: "human", action: "workspace.invitation-created", detail: { invitationId: invitation.id }, createdAt: invitation.createdAt };
    await repository.createWorkspaceInvitation(invitation, audit);
    expect(await repository.getWorkspaceInvitationByTokenSha256(invitation.tokenSha256, "2026-09-09T00:00:00.000Z")).toMatchObject({ status: "expired" });
    const rotated = await repository.resendWorkspaceInvitation("default", invitation.id, "d".repeat(64), "2026-09-16T00:00:00.000Z", "2026-09-09T00:00:00.000Z", { ...audit, id: "resend", action: "workspace.invitation-resent", createdAt: "2026-09-09T00:00:00.000Z" });
    expect(rotated).toMatchObject({ status: "pending", tokenSha256: "d".repeat(64) });
    await expect(repository.acceptWorkspaceInvitation({ tokenSha256: "d".repeat(64), acceptedAt: "2026-09-10T00:00:00.000Z", existingUserId: owner.user.id, event: { ...audit, id: "wrong", actorId: owner.user.id, action: "workspace.invitation-accepted", createdAt: "2026-09-10T00:00:00.000Z" } })).rejects.toMatchObject({ code: "workspace_invitation_email_mismatch" });
    await expect(repository.acceptWorkspaceInvitation({ tokenSha256: "d".repeat(64), acceptedAt: "2026-09-10T00:00:00.000Z", existingUserId: existing.user.id, event: { ...audit, id: "accept", actorId: existing.user.id, action: "workspace.invitation-accepted", createdAt: "2026-09-10T00:00:00.000Z" } })).resolves.toMatchObject({ member: { workspaceId: "default", role: "creator" } });
  });

  it("revokes sessions immediately and preserves the current session during password change", async () => {
    const repository = new InMemoryAuthRepository();
    await repository.createUserWithMembership(fixture("owner", "owner@example.com", "owner"));
    const base = { userId: "owner", csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-08-29T00:00:00.000Z", lastSeenAt: "2026-08-29T00:00:00.000Z" };
    await repository.createSession({ ...base, id: "one", tokenHash: "hash-one" });
    await repository.createSession({ ...base, id: "two", tokenHash: "hash-two" });
    await repository.revokeUserSessions("owner", "2026-08-29T00:03:00.000Z", "two");
    await expect(repository.findSessionByTokenHash("hash-one", "2026-08-29T00:04:00.000Z")).resolves.toBeNull();
    await expect(repository.findSessionByTokenHash("hash-two", "2026-08-29T00:04:00.000Z")).resolves.toMatchObject({ session: { id: "two" } });
  });
});
