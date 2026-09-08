import { ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, OnModuleInit, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { can, DomainError, type Actor, type AuditEvent, type AuthPrincipal, type AuthSession, type AuthUser, type Role, type WorkspaceInvitation, type WorkspaceMembership } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { ChangePasswordDto, CreateMemberDto, CreateWorkspaceInvitationDto, RegisterWorkspaceInvitationDto, ResendWorkspaceInvitationDto, WorkspaceInvitationTokenDto } from "./auth.dto.js";
import { PasswordService } from "./password.service.js";

export interface LoginResult {
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
  user: { id: string; email: string; displayName: string };
  memberships: WorkspaceMembership[];
}

function publicUser(user: AuthUser) { return { id: user.id, email: user.email, displayName: user.displayName } }

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyPasswordHash = "disabled";
  private readonly loginFailures = new Map<string, { attempts: number; windowStartedAt: number; blockedUntil?: number }>();
  private readonly invitationLimits = new Map<string, { attempts: number; windowStartedAt: number }>();

  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    private readonly passwords: PasswordService,
    private readonly config: ConfigService,
  ) {}

  mode(): "single-user" | "sessions" {
    return this.config.get<string>("AUTH_MODE") === "sessions" ? "sessions" : "single-user";
  }

  async onModuleInit(): Promise<void> {
    if (this.mode() !== "sessions") return;
    this.dummyPasswordHash = await this.passwords.hash(`not-a-user-${randomBytes(24).toString("base64url")}`);
    const email = this.config.get<string>("BOOTSTRAP_ADMIN_EMAIL")!.trim().toLowerCase();
    const existing = await this.infrastructure.authRepository.findUserByEmail(email);
    if (existing) {
      if (existing.status !== "active" || !await this.infrastructure.authRepository.getMembership("default", existing.id)) {
        throw new Error("BOOTSTRAP_ADMIN_EMAIL exists but is not an active owner of the default workspace.");
      }
      return;
    }
    const now = new Date().toISOString();
    const id = `user_${randomUUID()}`;
    const displayName = this.config.get<string>("BOOTSTRAP_ADMIN_NAME")?.trim() || "OriginPost Owner";
    const passwordHash = await this.passwords.hash(this.config.get<string>("BOOTSTRAP_ADMIN_PASSWORD")!);
    await this.infrastructure.authRepository.createUserWithMembership({
      user: { id, email, displayName, passwordHash, status: "active", createdAt: now, updatedAt: now },
      membership: { workspaceId: "default", workspaceName: "My workspace", workspaceSlug: "my-workspace", userId: id, role: "owner", createdAt: now, updatedAt: now },
      createdBy: id,
    });
  }

  async login(email: string, password: string, clientKey = "unknown"): Promise<LoginResult> {
    if (this.mode() !== "sessions") throw new ConflictException("Password login is disabled in single-user mode.");
    const normalizedEmail = email.trim().toLowerCase();
    const throttleKey = createHash("sha256").update(`${clientKey}:${normalizedEmail}`).digest("hex");
    const nowMs = Date.now();
    const currentFailure = this.loginFailures.get(throttleKey);
    if (currentFailure?.blockedUntil && currentFailure.blockedUntil > nowMs) {
      throw new HttpException("Too many sign-in attempts. Try again later.", HttpStatus.TOO_MANY_REQUESTS);
    }
    const user = await this.infrastructure.authRepository.findUserByEmail(normalizedEmail);
    const passwordMatches = await this.passwords.verify(password, user?.passwordHash ?? this.dummyPasswordHash);
    if (!user || user.status !== "active" || !passwordMatches) {
      const activeWindow = currentFailure && nowMs - currentFailure.windowStartedAt < 15 * 60_000;
      const attempts = activeWindow ? currentFailure.attempts + 1 : 1;
      this.loginFailures.set(throttleKey, { attempts, windowStartedAt: activeWindow ? currentFailure.windowStartedAt : nowMs, ...(attempts >= 5 ? { blockedUntil: nowMs + 15 * 60_000 } : {}) });
      if (this.loginFailures.size > 5_000) this.loginFailures.delete(this.loginFailures.keys().next().value as string);
      throw new UnauthorizedException("Email or password is incorrect.");
    }
    this.loginFailures.delete(throttleKey);
    return this.createSessionForUser(user);
  }

  async createSessionForUser(user: AuthUser): Promise<LoginResult> {
    if (user.status !== "active") throw new ForbiddenException("This account is disabled.");
    const memberships = await this.infrastructure.authRepository.listMemberships(user.id);
    if (!memberships.length) throw new ForbiddenException("This account has no workspace access.");
    const now = new Date();
    const days = this.config.get<number>("AUTH_SESSION_DAYS") ?? 14;
    const expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString();
    const sessionToken = randomBytes(32).toString("base64url");
    const session: AuthSession = {
      id: `session_${randomUUID()}`,
      userId: user.id,
      tokenHash: createHash("sha256").update(sessionToken).digest("hex"),
      csrfToken: randomBytes(24).toString("base64url"),
      expiresAt,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
    };
    await this.infrastructure.authRepository.createSession(session);
    return { sessionToken, csrfToken: session.csrfToken, expiresAt, user: publicUser(user), memberships };
  }

  async principal(sessionToken: string): Promise<AuthPrincipal | null> {
    const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
    return this.infrastructure.authRepository.findSessionByTokenHash(tokenHash, new Date().toISOString());
  }

  async me(userId: string, csrfToken: string | undefined, actor?: Actor, workspaceId = "default") {
    if (this.mode() === "single-user") {
      const local = actor ?? { id: userId, name: "Local Owner", role: "owner" as const };
      const workspaces = await this.infrastructure.organizationRepository.listWorkspaces();
      return {
        mode: "single-user" as const,
        user: { id: local.id, email: "local@originpost.invalid", displayName: local.name },
        memberships: workspaces.map((workspace) => ({ workspaceId: workspace.id, workspaceName: workspace.name, workspaceSlug: workspace.slug, userId: local.id, role: local.role, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt })),
      };
    }
    const user = await this.infrastructure.authRepository.getUser(userId);
    if (!user || user.status !== "active") throw new UnauthorizedException("Your session is no longer active.");
    return { mode: this.mode(), user: publicUser(user), memberships: await this.infrastructure.authRepository.listMemberships(user.id), ...(csrfToken ? { csrfToken } : {}) };
  }

  async logout(sessionId?: string): Promise<void> { if (sessionId) await this.infrastructure.authRepository.revokeSession(sessionId, new Date().toISOString()); }

  async listMembers(workspaceId: string, actor: Actor) {
    if (this.mode() !== "sessions") throw new ConflictException("Enable session login to manage workspace members.");
    if (!can(actor.role, "workspace:manage")) throw new DomainError("Only a workspace owner can manage members.", "permission_denied", 403);
    return this.infrastructure.authRepository.listWorkspaceMembers(workspaceId);
  }

  async createMember(workspaceId: string, dto: CreateMemberDto, actor: Actor) {
    if (this.mode() !== "sessions") throw new ConflictException("Enable session login to manage workspace members.");
    if (!can(actor.role, "workspace:manage")) throw new DomainError("Only a workspace owner can add members.", "permission_denied", 403);
    const now = new Date().toISOString();
    const id = `user_${randomUUID()}`;
    const email = dto.email.trim().toLowerCase();
    const displayName = dto.displayName.trim();
    const membership = await this.infrastructure.authRepository.getMembership(workspaceId, actor.id);
    if (!membership) throw new DomainError("Workspace access is required.", "workspace_access_denied", 403);
    return this.infrastructure.authRepository.createUserWithMembership({
      user: { id, email, displayName, passwordHash: await this.passwords.hash(dto.password), status: "active", createdAt: now, updatedAt: now },
      membership: { workspaceId, workspaceName: membership.workspaceName, workspaceSlug: membership.workspaceSlug, userId: id, role: dto.role, createdAt: now, updatedAt: now },
      createdBy: actor.id,
    });
  }

  async updateRole(workspaceId: string, userId: string, role: Role, actor: Actor) {
    if (this.mode() !== "sessions") throw new ConflictException("Enable session login to manage workspace members.");
    if (!can(actor.role, "workspace:manage")) throw new DomainError("Only a workspace owner can change member roles.", "permission_denied", 403);
    return this.infrastructure.authRepository.updateMembershipRole(workspaceId, userId, role, actor.id, new Date().toISOString());
  }

  async listInvitations(workspaceId: string, actor: Actor) {
    this.assertInvitationOwner(actor);
    const invitations = await this.infrastructure.authRepository.listWorkspaceInvitations(workspaceId, new Date().toISOString());
    return invitations.map((invitation) => this.invitationView(invitation));
  }

  async createInvitation(workspaceId: string, dto: CreateWorkspaceInvitationDto, actor: Actor, clientKey = "unknown") {
    this.assertInvitationOwner(actor);
    this.assertInvitationRate(`owner:${workspaceId}:${actor.id}:${clientKey}`, 20, 15 * 60_000);
    const membership = await this.infrastructure.authRepository.getMembership(workspaceId, actor.id);
    if (!membership) throw new DomainError("Workspace access is required.", "workspace_access_denied", 403);
    const now = new Date();
    const token = randomBytes(32).toString("base64url");
    const email = dto.email.trim().toLowerCase();
    const invitation: WorkspaceInvitation = {
      id: `invite_${randomUUID()}`, workspaceId, workspaceName: membership.workspaceName, workspaceSlug: membership.workspaceSlug,
      email, role: dto.role, status: "pending", deliveryState: "link_ready", tokenSha256: this.invitationTokenSha256(token),
      expiresAt: new Date(now.getTime() + (dto.expiresInDays ?? 7) * 86_400_000).toISOString(), invitedBy: actor.id, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    await this.infrastructure.authRepository.createWorkspaceInvitation(invitation, this.invitationEvent(invitation, actor.id, "workspace.invitation-created", now.toISOString(), { role: invitation.role, emailSha256: createHash("sha256").update(email).digest("hex"), expiresAt: invitation.expiresAt, deliveryState: invitation.deliveryState }));
    return { invitation: this.invitationView(invitation), url: this.invitationUrl(token) };
  }

  async revokeInvitation(workspaceId: string, invitationId: string, actor: Actor, clientKey = "unknown") {
    this.assertInvitationOwner(actor);
    this.assertInvitationRate(`owner:${workspaceId}:${actor.id}:${clientKey}`, 20, 15 * 60_000);
    const at = new Date().toISOString();
    const event = this.invitationEvent({ id: invitationId, workspaceId }, actor.id, "workspace.invitation-revoked", at);
    const invitation = await this.infrastructure.authRepository.revokeWorkspaceInvitation(workspaceId, invitationId, actor.id, at, event);
    if (!invitation) throw new DomainError("Pending invitation not found.", "workspace_invitation_not_found", 404);
    return this.invitationView(invitation);
  }

  async resendInvitation(workspaceId: string, invitationId: string, dto: ResendWorkspaceInvitationDto, actor: Actor, clientKey = "unknown") {
    this.assertInvitationOwner(actor);
    this.assertInvitationRate(`owner:${workspaceId}:${actor.id}:${clientKey}`, 20, 15 * 60_000);
    const now = new Date();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + (dto.expiresInDays ?? 7) * 86_400_000).toISOString();
    const event = this.invitationEvent({ id: invitationId, workspaceId }, actor.id, "workspace.invitation-resent", now.toISOString(), { expiresAt, deliveryState: "link_ready" });
    const invitation = await this.infrastructure.authRepository.resendWorkspaceInvitation(workspaceId, invitationId, this.invitationTokenSha256(token), expiresAt, now.toISOString(), event);
    if (!invitation) throw new DomainError("Only pending or expired invitations can be resent.", "workspace_invitation_not_resendable", 409);
    return { invitation: this.invitationView(invitation), url: this.invitationUrl(token) };
  }

  async previewInvitation(dto: WorkspaceInvitationTokenDto, clientKey = "unknown") {
    this.assertInvitationMode();
    this.assertInvitationRate(`preview:${clientKey}`, 60, 15 * 60_000);
    const invitation = await this.activeInvitation(dto.token);
    const [local, domain] = invitation.email.split("@");
    return { workspaceName: invitation.workspaceName, role: invitation.role, emailHint: `${local?.slice(0, 1) ?? "*"}***@${domain ?? "hidden"}`, expiresAt: invitation.expiresAt, deliveryState: invitation.deliveryState };
  }

  async registerInvitation(dto: RegisterWorkspaceInvitationDto, clientKey = "unknown"): Promise<LoginResult> {
    this.assertInvitationMode();
    this.assertInvitationRate(`register:${clientKey}`, 10, 15 * 60_000);
    const invitation = await this.activeInvitation(dto.token);
    if (await this.infrastructure.authRepository.findUserByEmail(invitation.email)) throw new DomainError("Sign in to your existing account to accept this invitation.", "workspace_invitation_sign_in_required", 409);
    const acceptedAt = new Date().toISOString();
    const newUser: AuthUser = {
      id: `user_${randomUUID()}`, email: invitation.email, displayName: dto.displayName.trim(), passwordHash: await this.passwords.hash(dto.password),
      status: "active", createdAt: acceptedAt, updatedAt: acceptedAt,
    };
    const event = this.invitationEvent(invitation, newUser.id, "workspace.invitation-accepted", acceptedAt, { userId: newUser.id, role: invitation.role });
    const accepted = await this.infrastructure.authRepository.acceptWorkspaceInvitation({ tokenSha256: this.invitationTokenSha256(dto.token), acceptedAt, newUser, event });
    return this.createSessionForUser(accepted.user);
  }

  async acceptInvitation(userId: string, dto: WorkspaceInvitationTokenDto, clientKey = "unknown") {
    this.assertInvitationMode();
    this.assertInvitationRate(`accept:${userId}:${clientKey}`, 20, 15 * 60_000);
    const invitation = await this.activeInvitation(dto.token);
    const user = await this.infrastructure.authRepository.getUser(userId);
    if (!user || user.status !== "active") throw new UnauthorizedException("Your session is no longer active.");
    const acceptedAt = new Date().toISOString();
    const event = this.invitationEvent(invitation, user.id, "workspace.invitation-accepted", acceptedAt, { userId: user.id, role: invitation.role });
    const accepted = await this.infrastructure.authRepository.acceptWorkspaceInvitation({ tokenSha256: this.invitationTokenSha256(dto.token), acceptedAt, existingUserId: user.id, event });
    return { member: accepted.member, memberships: await this.infrastructure.authRepository.listMemberships(user.id) };
  }

  async changePassword(userId: string, sessionId: string, dto: ChangePasswordDto): Promise<void> {
    if (this.mode() !== "sessions") throw new ConflictException("Password login is disabled in single-user mode.");
    const user = await this.infrastructure.authRepository.getUser(userId);
    if (!user || !await this.passwords.verify(dto.currentPassword, user.passwordHash)) throw new UnauthorizedException("Current password is incorrect.");
    const updatedAt = new Date().toISOString();
    await this.infrastructure.authRepository.updatePassword(userId, await this.passwords.hash(dto.newPassword), updatedAt);
    await this.infrastructure.authRepository.revokeUserSessions(userId, updatedAt, sessionId);
  }

  private assertInvitationMode(): void {
    if (this.mode() !== "sessions") throw new ConflictException("Workspace invitations require session login mode.");
  }

  private assertInvitationOwner(actor: Actor): void {
    this.assertInvitationMode();
    if (!can(actor.role, "workspace:manage")) throw new DomainError("Only a workspace owner can manage invitations.", "permission_denied", 403);
  }

  private assertInvitationRate(key: string, limit: number, windowMs: number): void {
    const now = Date.now();
    const current = this.invitationLimits.get(key);
    const entry = current && now - current.windowStartedAt < windowMs ? { attempts: current.attempts + 1, windowStartedAt: current.windowStartedAt } : { attempts: 1, windowStartedAt: now };
    this.invitationLimits.set(key, entry);
    if (this.invitationLimits.size > 5_000) {
      for (const [candidate, state] of this.invitationLimits) {
        if (now - state.windowStartedAt >= windowMs) this.invitationLimits.delete(candidate);
        if (this.invitationLimits.size <= 4_000) break;
      }
    }
    if (entry.attempts > limit) throw new HttpException("Too many invitation requests. Try again later.", HttpStatus.TOO_MANY_REQUESTS);
  }

  private invitationTokenSha256(token: string): string { return createHash("sha256").update(token).digest("hex"); }

  private invitationUrl(token: string): string {
    const base = (this.config.get<string>("WEB_PUBLIC_URL") ?? "http://localhost:3000").replace(/\/$/, "");
    return `${base}/invite#token=${encodeURIComponent(token)}`;
  }

  private invitationView(invitation: WorkspaceInvitation) {
    const { tokenSha256: _tokenSha256, workspaceSlug: _workspaceSlug, ...view } = invitation;
    return view;
  }

  private async activeInvitation(token: string): Promise<WorkspaceInvitation> {
    const invitation = await this.infrastructure.authRepository.getWorkspaceInvitationByTokenSha256(this.invitationTokenSha256(token), new Date().toISOString());
    if (!invitation || invitation.status !== "pending") throw new DomainError("This invitation is invalid, expired, or no longer available.", "workspace_invitation_unavailable", 404);
    return invitation;
  }

  private invitationEvent(invitation: Pick<WorkspaceInvitation, "id" | "workspaceId">, actorId: string, action: string, createdAt: string, extra: Record<string, unknown> = {}): AuditEvent {
    return { id: `evt_${randomUUID()}`, workspaceId: invitation.workspaceId, actorId, actorType: "human", action, detail: { invitationId: invitation.id, ...extra }, createdAt };
  }
}
