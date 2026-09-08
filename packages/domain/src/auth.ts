import { DomainError } from "./errors.js";
import type { AuditEvent, Role } from "./types.js";

export type AuthUserStatus = "active" | "disabled";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  status: AuthUserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMembership {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  userId: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  status: AuthUserStatus;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceInvitationStatus = "pending" | "accepted" | "revoked" | "expired";
export type WorkspaceInvitationDeliveryState = "link_ready";

export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  email: string;
  role: Role;
  status: WorkspaceInvitationStatus;
  deliveryState: WorkspaceInvitationDeliveryState;
  tokenSha256: string;
  expiresAt: string;
  invitedBy: string;
  createdAt: string;
  updatedAt: string;
  acceptedAt?: string | undefined;
  acceptedBy?: string | undefined;
  revokedAt?: string | undefined;
  revokedBy?: string | undefined;
}

export interface AuthSession {
  id: string;
  userId: string;
  tokenHash: string;
  csrfToken: string;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string | undefined;
}

export interface AuthPrincipal {
  user: AuthUser;
  session: AuthSession;
}

export interface OidcLoginState {
  id: string;
  stateHash: string;
  nonceHash: string;
  expiresAt: string;
  createdAt: string;
  consumedAt?: string | undefined;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  userId: string;
  email: string;
  createdAt: string;
  lastLoginAt: string;
}

export interface CreateOidcUserInput {
  user: AuthUser;
  membership: WorkspaceMembership;
  identity: OidcIdentity;
}

export interface CreateUserWithMembershipInput {
  user: AuthUser;
  membership: WorkspaceMembership;
  createdBy: string;
}

export interface AcceptWorkspaceInvitationInput {
  tokenSha256: string;
  acceptedAt: string;
  event: AuditEvent;
  existingUserId?: string | undefined;
  newUser?: AuthUser | undefined;
}

export interface AcceptedWorkspaceInvitation {
  invitation: WorkspaceInvitation;
  user: AuthUser;
  member: WorkspaceMember;
}

export interface AuthRepository {
  findUserByEmail(email: string): Promise<AuthUser | null>;
  getUser(id: string): Promise<AuthUser | null>;
  listMemberships(userId: string): Promise<WorkspaceMembership[]>;
  getMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | null>;
  listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  createUserWithMembership(input: CreateUserWithMembershipInput): Promise<WorkspaceMember>;
  updateMembershipRole(workspaceId: string, userId: string, role: Role, updatedBy: string, updatedAt: string): Promise<WorkspaceMember>;
  createWorkspaceInvitation(invitation: WorkspaceInvitation, event: AuditEvent): Promise<void>;
  listWorkspaceInvitations(workspaceId: string, now: string): Promise<WorkspaceInvitation[]>;
  getWorkspaceInvitationByTokenSha256(tokenSha256: string, now: string): Promise<WorkspaceInvitation | null>;
  revokeWorkspaceInvitation(workspaceId: string, invitationId: string, revokedBy: string, revokedAt: string, event: AuditEvent): Promise<WorkspaceInvitation | null>;
  resendWorkspaceInvitation(workspaceId: string, invitationId: string, tokenSha256: string, expiresAt: string, updatedAt: string, event: AuditEvent): Promise<WorkspaceInvitation | null>;
  acceptWorkspaceInvitation(input: AcceptWorkspaceInvitationInput): Promise<AcceptedWorkspaceInvitation>;
  updatePassword(userId: string, passwordHash: string, updatedAt: string): Promise<void>;
  createSession(session: AuthSession): Promise<void>;
  findSessionByTokenHash(tokenHash: string, now: string): Promise<AuthPrincipal | null>;
  touchSession(id: string, seenAt: string): Promise<void>;
  revokeSession(id: string, revokedAt: string): Promise<void>;
  revokeUserSessions(userId: string, revokedAt: string, exceptSessionId?: string): Promise<void>;
  createOidcLoginState(state: OidcLoginState): Promise<void>;
  consumeOidcLoginState(stateHash: string, consumedAt: string): Promise<OidcLoginState | null>;
  findUserByOidcIdentity(issuer: string, subject: string): Promise<AuthUser | null>;
  linkOidcIdentity(identity: OidcIdentity): Promise<void>;
  createOidcUserWithMembership(input: CreateOidcUserInput): Promise<AuthUser>;
}

export class InMemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, AuthUser>();
  private readonly memberships = new Map<string, WorkspaceMembership>();
  private readonly sessions = new Map<string, AuthSession>();
  private readonly oidcStates = new Map<string, OidcLoginState>();
  private readonly oidcIdentities = new Map<string, OidcIdentity>();
  private readonly invitations = new Map<string, WorkspaceInvitation>();

  addWorkspaceMembership(membership: WorkspaceMembership): void {
    if (!this.users.has(membership.userId)) return;
    this.memberships.set(`${membership.workspaceId}:${membership.userId}`, structuredClone(membership));
  }

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    const normalized = email.trim().toLowerCase();
    const user = [...this.users.values()].find((entry) => entry.email === normalized);
    return user ? structuredClone(user) : null;
  }

  async getUser(id: string): Promise<AuthUser | null> {
    const user = this.users.get(id);
    return user ? structuredClone(user) : null;
  }

  async listMemberships(userId: string): Promise<WorkspaceMembership[]> {
    return [...this.memberships.values()].filter((entry) => entry.userId === userId).map((entry) => structuredClone(entry));
  }

  async getMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | null> {
    const membership = this.memberships.get(`${workspaceId}:${userId}`);
    return membership ? structuredClone(membership) : null;
  }

  async listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    return [...this.memberships.values()].filter((entry) => entry.workspaceId === workspaceId && this.users.get(entry.userId)?.status === "active").map((entry) => {
      const user = this.users.get(entry.userId)!;
      return { workspaceId, userId: user.id, email: user.email, displayName: user.displayName, role: entry.role, status: user.status, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
    });
  }

  async createUserWithMembership(input: CreateUserWithMembershipInput): Promise<WorkspaceMember> {
    if ([...this.users.values()].some((entry) => entry.email === input.user.email)) {
      throw new DomainError("A user with this email already exists.", "user_email_exists", 409);
    }
    this.users.set(input.user.id, structuredClone(input.user));
    this.memberships.set(`${input.membership.workspaceId}:${input.user.id}`, structuredClone(input.membership));
    return { workspaceId: input.membership.workspaceId, userId: input.user.id, email: input.user.email, displayName: input.user.displayName, role: input.membership.role, status: input.user.status, createdAt: input.membership.createdAt, updatedAt: input.membership.updatedAt };
  }

  async updateMembershipRole(workspaceId: string, userId: string, role: Role, _updatedBy: string, updatedAt: string): Promise<WorkspaceMember> {
    const key = `${workspaceId}:${userId}`;
    const current = this.memberships.get(key);
    const user = this.users.get(userId);
    if (!current || !user) throw new DomainError("Workspace member not found.", "member_not_found", 404);
    if (current.role === "owner" && role !== "owner") {
      const owners = [...this.memberships.values()].filter((entry) => entry.workspaceId === workspaceId && entry.role === "owner" && this.users.get(entry.userId)?.status === "active").length;
      if (owners <= 1) throw new DomainError("A workspace must keep at least one owner.", "last_owner_required", 409);
    }
    const next = { ...current, role, updatedAt };
    this.memberships.set(key, next);
    return { workspaceId, userId, email: user.email, displayName: user.displayName, role, status: user.status, createdAt: next.createdAt, updatedAt };
  }

  private invitationView(value: WorkspaceInvitation, now: string): WorkspaceInvitation {
    return structuredClone(value.status === "pending" && value.expiresAt <= now ? { ...value, status: "expired" as const } : value);
  }

  async createWorkspaceInvitation(invitation: WorkspaceInvitation, _event: AuditEvent): Promise<void> {
    for (const [id, current] of this.invitations) {
      if (current.status === "pending" && current.expiresAt <= invitation.createdAt) this.invitations.set(id, { ...current, status: "expired", updatedAt: invitation.createdAt });
    }
    const existingUser = [...this.users.values()].find((user) => user.email === invitation.email);
    if (existingUser && this.memberships.has(`${invitation.workspaceId}:${existingUser.id}`)) throw new DomainError("This person is already a workspace member.", "workspace_member_exists", 409);
    if ([...this.invitations.values()].some((entry) => entry.workspaceId === invitation.workspaceId && entry.email === invitation.email && entry.status === "pending")) {
      throw new DomainError("A pending invitation already exists for this email.", "workspace_invitation_exists", 409);
    }
    if ([...this.invitations.values()].some((entry) => entry.tokenSha256 === invitation.tokenSha256)) throw new DomainError("Could not create a unique invitation.", "workspace_invitation_token_conflict", 409);
    this.invitations.set(invitation.id, structuredClone(invitation));
  }

  async listWorkspaceInvitations(workspaceId: string, now: string): Promise<WorkspaceInvitation[]> {
    return [...this.invitations.values()]
      .filter((entry) => entry.workspaceId === workspaceId)
      .map((entry) => this.invitationView(entry, now))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getWorkspaceInvitationByTokenSha256(tokenSha256: string, now: string): Promise<WorkspaceInvitation | null> {
    const invitation = [...this.invitations.values()].find((entry) => entry.tokenSha256 === tokenSha256);
    return invitation ? this.invitationView(invitation, now) : null;
  }

  async revokeWorkspaceInvitation(workspaceId: string, invitationId: string, revokedBy: string, revokedAt: string, _event: AuditEvent): Promise<WorkspaceInvitation | null> {
    const current = this.invitations.get(invitationId);
    if (!current || current.workspaceId !== workspaceId || current.status !== "pending" || current.expiresAt <= revokedAt) return null;
    const next: WorkspaceInvitation = { ...current, status: "revoked", revokedAt, revokedBy, updatedAt: revokedAt };
    this.invitations.set(invitationId, next);
    return structuredClone(next);
  }

  async resendWorkspaceInvitation(workspaceId: string, invitationId: string, tokenSha256: string, expiresAt: string, updatedAt: string, _event: AuditEvent): Promise<WorkspaceInvitation | null> {
    const current = this.invitations.get(invitationId);
    if (!current || current.workspaceId !== workspaceId || current.status === "accepted" || current.status === "revoked") return null;
    if ([...this.invitations.values()].some((entry) => entry.id !== invitationId && entry.tokenSha256 === tokenSha256)) throw new DomainError("Could not rotate the invitation link.", "workspace_invitation_token_conflict", 409);
    const next: WorkspaceInvitation = { ...current, status: "pending", tokenSha256, expiresAt, deliveryState: "link_ready", updatedAt, acceptedAt: undefined, acceptedBy: undefined, revokedAt: undefined, revokedBy: undefined };
    this.invitations.set(invitationId, next);
    return structuredClone(next);
  }

  async acceptWorkspaceInvitation(input: AcceptWorkspaceInvitationInput): Promise<AcceptedWorkspaceInvitation> {
    const current = [...this.invitations.values()].find((entry) => entry.tokenSha256 === input.tokenSha256);
    if (!current || current.status !== "pending" || current.expiresAt <= input.acceptedAt) throw new DomainError("This invitation is invalid, expired, or no longer available.", "workspace_invitation_unavailable", 404);
    const existing = input.existingUserId ? this.users.get(input.existingUserId) : undefined;
    if (input.existingUserId && (!existing || existing.status !== "active" || existing.email !== current.email)) throw new DomainError("Sign in with the email address that received this invitation.", "workspace_invitation_email_mismatch", 403);
    const byEmail = [...this.users.values()].find((entry) => entry.email === current.email);
    if (!input.existingUserId && byEmail) throw new DomainError("Sign in to your existing account to accept this invitation.", "workspace_invitation_sign_in_required", 409);
    if (input.existingUserId && byEmail?.id !== input.existingUserId) throw new DomainError("Sign in with the email address that received this invitation.", "workspace_invitation_email_mismatch", 403);
    if (!input.existingUserId && (!input.newUser || input.newUser.email !== current.email || input.newUser.status !== "active")) throw new DomainError("The new account does not match this invitation.", "workspace_invitation_email_mismatch", 403);
    const user = existing ?? input.newUser!;
    if (!existing) this.users.set(user.id, structuredClone(user));
    const membership: WorkspaceMembership = { workspaceId: current.workspaceId, workspaceName: current.workspaceName, workspaceSlug: current.workspaceSlug, userId: user.id, role: current.role, createdAt: input.acceptedAt, updatedAt: input.acceptedAt };
    this.memberships.set(`${current.workspaceId}:${user.id}`, membership);
    const invitation: WorkspaceInvitation = { ...current, status: "accepted", acceptedAt: input.acceptedAt, acceptedBy: user.id, updatedAt: input.acceptedAt };
    this.invitations.set(current.id, invitation);
    return { invitation: structuredClone(invitation), user: structuredClone(user), member: { workspaceId: current.workspaceId, userId: user.id, email: user.email, displayName: user.displayName, role: current.role, status: user.status, createdAt: membership.createdAt, updatedAt: membership.updatedAt } };
  }

  async updatePassword(userId: string, passwordHash: string, updatedAt: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new DomainError("User not found.", "user_not_found", 404);
    this.users.set(userId, { ...user, passwordHash, updatedAt });
  }

  async createSession(session: AuthSession): Promise<void> { this.sessions.set(session.id, structuredClone(session)); }

  async findSessionByTokenHash(tokenHash: string, now: string): Promise<AuthPrincipal | null> {
    const session = [...this.sessions.values()].find((entry) => entry.tokenHash === tokenHash && !entry.revokedAt && entry.expiresAt > now);
    const user = session ? this.users.get(session.userId) : undefined;
    return session && user?.status === "active" ? { session: structuredClone(session), user: structuredClone(user) } : null;
  }

  async touchSession(id: string, seenAt: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, lastSeenAt: seenAt });
  }

  async revokeSession(id: string, revokedAt: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, revokedAt });
  }

  async revokeUserSessions(userId: string, revokedAt: string, exceptSessionId?: string): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.userId === userId && id !== exceptSessionId) this.sessions.set(id, { ...session, revokedAt });
    }
  }

  async createOidcLoginState(state: OidcLoginState): Promise<void> {
    this.oidcStates.set(state.stateHash, structuredClone(state));
  }

  async consumeOidcLoginState(stateHash: string, consumedAt: string): Promise<OidcLoginState | null> {
    const state = this.oidcStates.get(stateHash);
    if (!state || state.consumedAt || state.expiresAt <= consumedAt) return null;
    const consumed = { ...state, consumedAt };
    this.oidcStates.set(stateHash, consumed);
    return structuredClone(consumed);
  }

  async findUserByOidcIdentity(issuer: string, subject: string): Promise<AuthUser | null> {
    const identity = this.oidcIdentities.get(`${issuer}:${subject}`);
    const found = identity ? this.users.get(identity.userId) : undefined;
    return found ? structuredClone(found) : null;
  }

  async linkOidcIdentity(identity: OidcIdentity): Promise<void> {
    const key = `${identity.issuer}:${identity.subject}`;
    const existing = this.oidcIdentities.get(key);
    if (existing && existing.userId !== identity.userId) throw new DomainError("This identity is already linked to another user.", "oidc_identity_conflict", 409);
    const otherSubject = [...this.oidcIdentities.values()].find((entry) => entry.issuer === identity.issuer && entry.userId === identity.userId && entry.subject !== identity.subject);
    if (otherSubject) throw new DomainError("This user is already linked to another identity from this issuer.", "oidc_identity_conflict", 409);
    this.oidcIdentities.set(key, structuredClone(identity));
  }

  async createOidcUserWithMembership(input: CreateOidcUserInput): Promise<AuthUser> {
    if ([...this.users.values()].some((entry) => entry.email === input.user.email)) throw new DomainError("A user with this email already exists.", "user_email_exists", 409);
    this.users.set(input.user.id, structuredClone(input.user));
    this.memberships.set(`${input.membership.workspaceId}:${input.user.id}`, structuredClone(input.membership));
    this.oidcIdentities.set(`${input.identity.issuer}:${input.identity.subject}`, structuredClone(input.identity));
    return structuredClone(input.user);
  }
}
