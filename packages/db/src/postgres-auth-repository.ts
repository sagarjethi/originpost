import { randomUUID } from "node:crypto";
import { DomainError, type AcceptWorkspaceInvitationInput, type AcceptedWorkspaceInvitation, type AuditEvent, type AuthPrincipal, type AuthRepository, type AuthSession, type AuthUser, type CreateOidcUserInput, type CreateUserWithMembershipInput, type OidcIdentity, type OidcLoginState, type Role, type WorkspaceInvitation, type WorkspaceMember, type WorkspaceMembership } from "@originpost/domain";
import type { Sql } from "postgres";

type UserRow = { id: string; email: string; display_name: string; password_hash: string; status: AuthUser["status"]; created_at: Date; updated_at: Date };
type MembershipRow = { workspace_id: string; workspace_name: string; workspace_slug: string; user_id: string; role: Role; created_at: Date; updated_at: Date };
type MemberRow = { workspace_id: string; user_id: string; email: string; display_name: string; role: Role; status: AuthUser["status"]; created_at: Date; updated_at: Date };
type SessionRow = { id: string; user_id: string; token_hash: string; csrf_token: string; expires_at: Date; created_at: Date; last_seen_at: Date; revoked_at: Date | null };
type PrincipalRow = SessionRow & { email: string; display_name: string; password_hash: string; status: AuthUser["status"]; user_created_at: Date; user_updated_at: Date };
type OidcStateRow = { id: string; state_hash: string; nonce_hash: string; expires_at: Date; created_at: Date; consumed_at: Date | null };
type InvitationRow = {
  id: string; workspace_id: string; workspace_name: string; workspace_slug: string; email: string; role: Role;
  status: WorkspaceInvitation["status"]; delivery_state: WorkspaceInvitation["deliveryState"]; token_sha256: string;
  expires_at: Date; invited_by: string; created_at: Date; updated_at: Date;
  accepted_at: Date | null; accepted_by: string | null; revoked_at: Date | null; revoked_by: string | null;
};

function user(row: UserRow): AuthUser {
  return { id: row.id, email: row.email, displayName: row.display_name, passwordHash: row.password_hash, status: row.status, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

function membership(row: MembershipRow): WorkspaceMembership {
  return { workspaceId: row.workspace_id, workspaceName: row.workspace_name, workspaceSlug: row.workspace_slug, userId: row.user_id, role: row.role, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

function member(row: MemberRow): WorkspaceMember {
  return { workspaceId: row.workspace_id, userId: row.user_id, email: row.email, displayName: row.display_name, role: row.role, status: row.status, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

function session(row: SessionRow): AuthSession {
  return { id: row.id, userId: row.user_id, tokenHash: row.token_hash, csrfToken: row.csrf_token, expiresAt: row.expires_at.toISOString(), createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(), ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}) };
}

function oidcState(row: OidcStateRow): OidcLoginState {
  return { id: row.id, stateHash: row.state_hash, nonceHash: row.nonce_hash, expiresAt: row.expires_at.toISOString(), createdAt: row.created_at.toISOString(), ...(row.consumed_at ? { consumedAt: row.consumed_at.toISOString() } : {}) };
}

function invitation(row: InvitationRow, now?: string): WorkspaceInvitation {
  const status = row.status === "pending" && now && row.expires_at.toISOString() <= now ? "expired" : row.status;
  return {
    id: row.id, workspaceId: row.workspace_id, workspaceName: row.workspace_name, workspaceSlug: row.workspace_slug,
    email: row.email, role: row.role, status, deliveryState: row.delivery_state, tokenSha256: row.token_sha256,
    expiresAt: row.expires_at.toISOString(), invitedBy: row.invited_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    ...(row.accepted_at ? { acceptedAt: row.accepted_at.toISOString() } : {}), ...(row.accepted_by ? { acceptedBy: row.accepted_by } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}), ...(row.revoked_by ? { revokedBy: row.revoked_by } : {}),
  };
}

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly sql: Sql) {}

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    const rows = await this.sql<UserRow[]>`select * from auth_users where email = ${email.trim().toLowerCase()} limit 1`;
    return rows[0] ? user(rows[0]) : null;
  }

  async getUser(id: string): Promise<AuthUser | null> {
    const rows = await this.sql<UserRow[]>`select * from auth_users where id = ${id} limit 1`;
    return rows[0] ? user(rows[0]) : null;
  }

  async listMemberships(userId: string): Promise<WorkspaceMembership[]> {
    const rows = await this.sql<MembershipRow[]>`select m.workspace_id, w.name as workspace_name, w.slug as workspace_slug, m.user_id, m.role, m.created_at, m.updated_at from workspace_members m join workspaces w on w.id = m.workspace_id where m.user_id = ${userId} order by w.name`;
    return rows.map(membership);
  }

  async getMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | null> {
    const rows = await this.sql<MembershipRow[]>`select m.workspace_id, w.name as workspace_name, w.slug as workspace_slug, m.user_id, m.role, m.created_at, m.updated_at from workspace_members m join workspaces w on w.id = m.workspace_id where m.workspace_id = ${workspaceId} and m.user_id = ${userId} limit 1`;
    return rows[0] ? membership(rows[0]) : null;
  }

  async listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const rows = await this.sql<MemberRow[]>`select m.workspace_id, m.user_id, u.email, u.display_name, m.role, u.status, m.created_at, m.updated_at from workspace_members m join auth_users u on u.id = m.user_id where m.workspace_id = ${workspaceId} and u.status = 'active' order by case m.role when 'owner' then 1 when 'manager' then 2 when 'creator' then 3 else 4 end, u.display_name`;
    return rows.map(member);
  }

  async createUserWithMembership(input: CreateUserWithMembershipInput): Promise<WorkspaceMember> {
    try {
      return await this.sql.begin(async (sql) => {
        await sql`insert into auth_users (id, email, display_name, password_hash, status, created_at, updated_at) values (${input.user.id}, ${input.user.email}, ${input.user.displayName}, ${input.user.passwordHash}, ${input.user.status}, ${input.user.createdAt}, ${input.user.updatedAt})`;
        await sql`insert into workspace_members (workspace_id, user_id, display_name, role, created_at, updated_at) values (${input.membership.workspaceId}, ${input.user.id}, ${input.user.displayName}, ${input.membership.role}, ${input.membership.createdAt}, ${input.membership.updatedAt})`;
        await sql`insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at) values (${`evt_${randomUUID()}`}, ${input.membership.workspaceId}, null, ${input.createdBy}, 'human', 'workspace.member-created', ${sql.json({ userId: input.user.id, role: input.membership.role } as never)}, ${input.membership.createdAt})`;
        return { workspaceId: input.membership.workspaceId, userId: input.user.id, email: input.user.email, displayName: input.user.displayName, role: input.membership.role, status: input.user.status, createdAt: input.membership.createdAt, updatedAt: input.membership.updatedAt };
      });
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "23505") throw new DomainError("A user with this email already exists.", "user_email_exists", 409);
      throw error;
    }
  }

  async updateMembershipRole(workspaceId: string, userId: string, role: Role, updatedBy: string, updatedAt: string): Promise<WorkspaceMember> {
    return this.sql.begin(async (sql) => {
      const current = await sql<{ role: Role }[]>`select role from workspace_members where workspace_id = ${workspaceId} and user_id = ${userId} for update`;
      if (!current[0]) throw new DomainError("Workspace member not found.", "member_not_found", 404);
      if (current[0].role === "owner" && role !== "owner") {
        const owners = await sql<{ count: string }[]>`select count(*)::text as count from workspace_members m join auth_users u on u.id = m.user_id where m.workspace_id = ${workspaceId} and m.role = 'owner' and u.status = 'active'`;
        if (Number(owners[0]?.count ?? 0) <= 1) throw new DomainError("A workspace must keep at least one owner.", "last_owner_required", 409);
      }
      await sql`update workspace_members set role = ${role}, updated_at = ${updatedAt} where workspace_id = ${workspaceId} and user_id = ${userId}`;
      await sql`insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at) values (${`evt_${randomUUID()}`}, ${workspaceId}, null, ${updatedBy}, 'human', 'workspace.member-role-updated', ${sql.json({ userId, from: current[0].role, to: role } as never)}, ${updatedAt})`;
      const rows = await sql<MemberRow[]>`select m.workspace_id, m.user_id, u.email, u.display_name, m.role, u.status, m.created_at, m.updated_at from workspace_members m join auth_users u on u.id = m.user_id where m.workspace_id = ${workspaceId} and m.user_id = ${userId}`;
      return member(rows[0]!);
    });
  }

  async createWorkspaceInvitation(value: WorkspaceInvitation, event: AuditEvent): Promise<void> {
    if (value.workspaceId !== event.workspaceId || event.detail.invitationId !== value.id) throw new Error("Invitation and audit event must have matching lineage.");
    try {
      await this.sql.begin(async (sql) => {
        await sql`update workspace_invitations set status = 'expired', updated_at = ${value.createdAt} where workspace_id = ${value.workspaceId} and email = ${value.email} and status = 'pending' and expires_at <= ${value.createdAt}`;
        const members = await sql<{ user_id: string }[]>`select m.user_id from workspace_members m join auth_users u on u.id = m.user_id where m.workspace_id = ${value.workspaceId} and u.email = ${value.email} limit 1`;
        if (members.length) throw new DomainError("This person is already a workspace member.", "workspace_member_exists", 409);
        await sql`insert into workspace_invitations (id, workspace_id, email, role, status, delivery_state, token_sha256, expires_at, invited_by, created_at, updated_at) values (${value.id}, ${value.workspaceId}, ${value.email}, ${value.role}, ${value.status}, ${value.deliveryState}, ${value.tokenSha256}, ${value.expiresAt}, ${value.invitedBy}, ${value.createdAt}, ${value.updatedAt})`;
        await sql`insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at) values (${event.id}, ${event.workspaceId}, null, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt})`;
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "23505") throw new DomainError("A pending invitation already exists for this email.", "workspace_invitation_exists", 409);
      throw error;
    }
  }

  async listWorkspaceInvitations(workspaceId: string, now: string): Promise<WorkspaceInvitation[]> {
    const rows = await this.sql<InvitationRow[]>`select i.*, w.name as workspace_name, w.slug as workspace_slug from workspace_invitations i join workspaces w on w.id = i.workspace_id where i.workspace_id = ${workspaceId} order by i.created_at desc, i.id`;
    return rows.map((row) => invitation(row, now));
  }

  async getWorkspaceInvitationByTokenSha256(tokenSha256: string, now: string): Promise<WorkspaceInvitation | null> {
    const rows = await this.sql<InvitationRow[]>`select i.*, w.name as workspace_name, w.slug as workspace_slug from workspace_invitations i join workspaces w on w.id = i.workspace_id where i.token_sha256 = ${tokenSha256} limit 1`;
    return rows[0] ? invitation(rows[0], now) : null;
  }

  async revokeWorkspaceInvitation(workspaceId: string, invitationId: string, revokedBy: string, revokedAt: string, event: AuditEvent): Promise<WorkspaceInvitation | null> {
    if (workspaceId !== event.workspaceId || event.detail.invitationId !== invitationId) throw new Error("Invitation revocation and audit event must have matching lineage.");
    return this.sql.begin(async (sql) => {
      const rows = await sql<InvitationRow[]>`with changed as (update workspace_invitations set status = 'revoked', revoked_at = ${revokedAt}, revoked_by = ${revokedBy}, updated_at = ${revokedAt} where workspace_id = ${workspaceId} and id = ${invitationId} and status = 'pending' and expires_at > ${revokedAt} returning *) select changed.*, w.name as workspace_name, w.slug as workspace_slug from changed join workspaces w on w.id = changed.workspace_id`;
      if (!rows[0]) return null;
      await sql`insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at) values (${event.id}, ${event.workspaceId}, null, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt})`;
      return invitation(rows[0]);
    });
  }

  async resendWorkspaceInvitation(workspaceId: string, invitationId: string, tokenSha256: string, expiresAt: string, updatedAt: string, event: AuditEvent): Promise<WorkspaceInvitation | null> {
    if (workspaceId !== event.workspaceId || event.detail.invitationId !== invitationId) throw new Error("Invitation resend and audit event must have matching lineage.");
    try {
      return await this.sql.begin(async (sql) => {
        const rows = await sql<InvitationRow[]>`with changed as (update workspace_invitations set status = 'pending', delivery_state = 'link_ready', token_sha256 = ${tokenSha256}, expires_at = ${expiresAt}, accepted_at = null, accepted_by = null, revoked_at = null, revoked_by = null, updated_at = ${updatedAt} where workspace_id = ${workspaceId} and id = ${invitationId} and status in ('pending', 'expired') returning *) select changed.*, w.name as workspace_name, w.slug as workspace_slug from changed join workspaces w on w.id = changed.workspace_id`;
        if (!rows[0]) return null;
        await sql`insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at) values (${event.id}, ${event.workspaceId}, null, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt})`;
        return invitation(rows[0]);
      });
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "23505") throw new DomainError("Could not rotate the invitation link.", "workspace_invitation_token_conflict", 409);
      throw error;
    }
  }

  async acceptWorkspaceInvitation(input: AcceptWorkspaceInvitationInput): Promise<AcceptedWorkspaceInvitation> {
    return this.sql.begin(async (sql) => {
      const rows = await sql<InvitationRow[]>`select i.*, w.name as workspace_name, w.slug as workspace_slug from workspace_invitations i join workspaces w on w.id = i.workspace_id where i.token_sha256 = ${input.tokenSha256} limit 1 for update of i`;
      const current = rows[0];
      if (!current || current.status !== "pending" || current.expires_at.toISOString() <= input.acceptedAt) throw new DomainError("This invitation is invalid, expired, or no longer available.", "workspace_invitation_unavailable", 404);
      if (input.event.workspaceId !== current.workspace_id || input.event.detail.invitationId !== current.id) throw new Error("Invitation acceptance and audit event must have matching lineage.");
      const byEmail = await sql<UserRow[]>`select * from auth_users where email = ${current.email} limit 1 for update`;
      let acceptedUser = byEmail[0];
      if (input.existingUserId) {
        if (!acceptedUser || acceptedUser.id !== input.existingUserId || acceptedUser.status !== "active") throw new DomainError("Sign in with the email address that received this invitation.", "workspace_invitation_email_mismatch", 403);
      } else {
        if (acceptedUser) throw new DomainError("Sign in to your existing account to accept this invitation.", "workspace_invitation_sign_in_required", 409);
        if (!input.newUser || input.newUser.email !== current.email || input.newUser.status !== "active") throw new DomainError("The new account does not match this invitation.", "workspace_invitation_email_mismatch", 403);
        await sql`insert into auth_users (id, email, display_name, password_hash, status, created_at, updated_at) values (${input.newUser.id}, ${input.newUser.email}, ${input.newUser.displayName}, ${input.newUser.passwordHash}, ${input.newUser.status}, ${input.newUser.createdAt}, ${input.newUser.updatedAt})`;
        acceptedUser = { id: input.newUser.id, email: input.newUser.email, display_name: input.newUser.displayName, password_hash: input.newUser.passwordHash, status: input.newUser.status, created_at: new Date(input.newUser.createdAt), updated_at: new Date(input.newUser.updatedAt) };
      }
      const inserted = await sql<{ workspace_id: string }[]>`insert into workspace_members (workspace_id, user_id, display_name, role, created_at, updated_at) values (${current.workspace_id}, ${acceptedUser!.id}, ${acceptedUser!.display_name}, ${current.role}, ${input.acceptedAt}, ${input.acceptedAt}) on conflict (workspace_id, user_id) do nothing returning workspace_id`;
      if (!inserted.length) throw new DomainError("This person is already a workspace member.", "workspace_member_exists", 409);
      const changed = await sql<InvitationRow[]>`with accepted as (update workspace_invitations set status = 'accepted', accepted_at = ${input.acceptedAt}, accepted_by = ${acceptedUser!.id}, updated_at = ${input.acceptedAt} where id = ${current.id} and status = 'pending' returning *) select accepted.*, w.name as workspace_name, w.slug as workspace_slug from accepted join workspaces w on w.id = accepted.workspace_id`;
      if (!changed[0]) throw new DomainError("This invitation is invalid, expired, or no longer available.", "workspace_invitation_unavailable", 404);
      await sql`insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at) values (${input.event.id}, ${input.event.workspaceId}, null, ${input.event.actorId}, ${input.event.actorType}, ${input.event.action}, ${sql.json(input.event.detail as never)}, ${input.event.createdAt})`;
      const savedUser = user(acceptedUser!);
      return {
        invitation: invitation(changed[0]), user: savedUser,
        member: { workspaceId: current.workspace_id, userId: savedUser.id, email: savedUser.email, displayName: savedUser.displayName, role: current.role, status: savedUser.status, createdAt: input.acceptedAt, updatedAt: input.acceptedAt },
      };
    });
  }

  async updatePassword(userId: string, passwordHash: string, updatedAt: string): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`update auth_users set password_hash = ${passwordHash}, updated_at = ${updatedAt} where id = ${userId} and status = 'active' returning id`;
    if (!rows.length) throw new DomainError("User not found.", "user_not_found", 404);
  }

  async createSession(value: AuthSession): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`insert into auth_sessions (id, user_id, token_hash, csrf_token, expires_at, created_at, last_seen_at, revoked_at) values (${value.id}, ${value.userId}, ${value.tokenHash}, ${value.csrfToken}, ${value.expiresAt}, ${value.createdAt}, ${value.lastSeenAt}, ${value.revokedAt ?? null})`;
      await sql`delete from auth_sessions where id in (select id from auth_sessions where user_id = ${value.userId} order by created_at desc offset 10)`;
    });
  }

  async findSessionByTokenHash(tokenHash: string, now: string): Promise<AuthPrincipal | null> {
    const rows = await this.sql<PrincipalRow[]>`select s.id, s.user_id, s.token_hash, s.csrf_token, s.expires_at, s.created_at, s.last_seen_at, s.revoked_at, u.email, u.display_name, u.password_hash, u.status, u.created_at as user_created_at, u.updated_at as user_updated_at from auth_sessions s join auth_users u on u.id = s.user_id where s.token_hash = ${tokenHash} and s.revoked_at is null and s.expires_at > ${now} and u.status = 'active' limit 1`;
    const row = rows[0];
    if (!row) return null;
    return {
      session: session(row),
      user: { id: row.user_id, email: row.email, displayName: row.display_name, passwordHash: row.password_hash, status: row.status, createdAt: row.user_created_at.toISOString(), updatedAt: row.user_updated_at.toISOString() },
    };
  }

  async touchSession(id: string, seenAt: string): Promise<void> { await this.sql`update auth_sessions set last_seen_at = ${seenAt} where id = ${id} and revoked_at is null`; }
  async revokeSession(id: string, revokedAt: string): Promise<void> { await this.sql`update auth_sessions set revoked_at = coalesce(revoked_at, ${revokedAt}) where id = ${id}`; }
  async revokeUserSessions(userId: string, revokedAt: string, exceptSessionId?: string): Promise<void> { await this.sql`update auth_sessions set revoked_at = coalesce(revoked_at, ${revokedAt}) where user_id = ${userId} and (${exceptSessionId ?? null}::text is null or id <> ${exceptSessionId ?? null})`; }

  async createOidcLoginState(value: OidcLoginState): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`delete from auth_oidc_login_states where expires_at < now() - interval '1 hour'`;
      await sql`insert into auth_oidc_login_states (id, state_hash, nonce_hash, expires_at, created_at, consumed_at) values (${value.id}, ${value.stateHash}, ${value.nonceHash}, ${value.expiresAt}, ${value.createdAt}, ${value.consumedAt ?? null})`;
    });
  }

  async consumeOidcLoginState(stateHash: string, consumedAt: string): Promise<OidcLoginState | null> {
    const rows = await this.sql<OidcStateRow[]>`update auth_oidc_login_states set consumed_at = ${consumedAt} where state_hash = ${stateHash} and consumed_at is null and expires_at > ${consumedAt} returning *`;
    return rows[0] ? oidcState(rows[0]) : null;
  }

  async findUserByOidcIdentity(issuer: string, subject: string): Promise<AuthUser | null> {
    const rows = await this.sql<UserRow[]>`select u.* from auth_oidc_identities i join auth_users u on u.id = i.user_id where i.issuer = ${issuer} and i.subject = ${subject} limit 1`;
    return rows[0] ? user(rows[0]) : null;
  }

  async linkOidcIdentity(identity: OidcIdentity): Promise<void> {
    try {
      await this.sql.begin(async (sql) => {
        const current = await sql<{ user_id: string }[]>`select user_id from auth_oidc_identities where issuer = ${identity.issuer} and subject = ${identity.subject} for update`;
        if (current[0] && current[0].user_id !== identity.userId) throw new DomainError("This identity is already linked to another user.", "oidc_identity_conflict", 409);
        if (current[0]) await sql`update auth_oidc_identities set email = ${identity.email}, last_login_at = ${identity.lastLoginAt} where issuer = ${identity.issuer} and subject = ${identity.subject}`;
        else await sql`insert into auth_oidc_identities (issuer, subject, user_id, email, created_at, last_login_at) values (${identity.issuer}, ${identity.subject}, ${identity.userId}, ${identity.email}, ${identity.createdAt}, ${identity.lastLoginAt})`;
      });
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "23505") throw new DomainError("This identity is already linked to another user.", "oidc_identity_conflict", 409);
      throw error;
    }
  }

  async createOidcUserWithMembership(input: CreateOidcUserInput): Promise<AuthUser> {
    try {
      return await this.sql.begin(async (sql) => {
        await sql`insert into auth_users (id, email, display_name, password_hash, status, created_at, updated_at) values (${input.user.id}, ${input.user.email}, ${input.user.displayName}, ${input.user.passwordHash}, ${input.user.status}, ${input.user.createdAt}, ${input.user.updatedAt})`;
        await sql`insert into workspace_members (workspace_id, user_id, display_name, role, created_at, updated_at) values (${input.membership.workspaceId}, ${input.user.id}, ${input.user.displayName}, ${input.membership.role}, ${input.membership.createdAt}, ${input.membership.updatedAt})`;
        await sql`insert into auth_oidc_identities (issuer, subject, user_id, email, created_at, last_login_at) values (${input.identity.issuer}, ${input.identity.subject}, ${input.user.id}, ${input.identity.email}, ${input.identity.createdAt}, ${input.identity.lastLoginAt})`;
        await sql`insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at) values (${`evt_${randomUUID()}`}, ${input.membership.workspaceId}, null, ${input.user.id}, 'human', 'workspace.member-created-via-oidc', ${sql.json({ userId: input.user.id, role: input.membership.role, issuer: input.identity.issuer } as never)}, ${input.user.createdAt})`;
        return input.user;
      });
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "23505") throw new DomainError("This email or identity is already registered.", "oidc_identity_conflict", 409);
      throw error;
    }
  }
}
