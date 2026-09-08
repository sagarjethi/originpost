import { ConflictException, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AuthUser, Role } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { AuthService, type LoginResult } from "./auth.service.js";
import { OIDC_PROVIDER, type OidcClaims, type OidcProvider } from "./oidc-provider.js";

export interface OidcStartResult {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: string;
}

function csv(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

@Injectable()
export class OidcAuthService {
  constructor(
    private readonly config: ConfigService,
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    @Inject(OIDC_PROVIDER) private readonly provider: OidcProvider,
    private readonly auth: AuthService,
  ) {}

  enabled(): boolean {
    return this.auth.mode() === "sessions" && this.config.get<boolean>("OIDC_ENABLED") === true;
  }

  displayName(): string { return this.config.get<string>("OIDC_DISPLAY_NAME") ?? "Single sign-on"; }
  redirectUri(): string { return this.config.get<string>("OIDC_REDIRECT_URI")!; }
  webReturnUrl(): string { return this.config.get<string>("OIDC_WEB_RETURN_URL")!; }

  async start(): Promise<OidcStartResult> {
    if (!this.enabled()) throw new ConflictException("OIDC single sign-on is not enabled.");
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    await this.infrastructure.authRepository.createOidcLoginState({ id: `oidc_state_${randomUUID()}`, stateHash: hash(state), nonceHash: hash(nonce), expiresAt, createdAt: now.toISOString() });
    const scopes = [...new Set(["openid", "email", "profile", ...csv(this.config.get<string>("OIDC_SCOPES"))])];
    return { authorizationUrl: await this.provider.authorizationUrl({ state, nonce, codeChallenge, redirectUri: this.redirectUri(), scopes }), state, nonce, codeVerifier, expiresAt };
  }

  async callback(input: { code: string; state: string; stateCookie: string; nonceCookie: string; codeVerifierCookie: string; responseIssuer?: string }): Promise<LoginResult> {
    if (!this.enabled()) throw new ConflictException("OIDC single sign-on is not enabled.");
    if (input.responseIssuer && input.responseIssuer !== this.config.get<string>("OIDC_ISSUER_URL")) throw new UnauthorizedException("OIDC response issuer does not match the configured provider.");
    if (!same(input.state, input.stateCookie)) throw new UnauthorizedException("OIDC sign-in state is invalid or expired.");
    const now = new Date().toISOString();
    const state = await this.infrastructure.authRepository.consumeOidcLoginState(hash(input.state), now);
    if (!state || !same(state.nonceHash, hash(input.nonceCookie))) throw new UnauthorizedException("OIDC sign-in state is invalid or expired.");
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(input.codeVerifierCookie)) throw new UnauthorizedException("OIDC sign-in verifier is invalid.");
    const claims = await this.provider.authenticate({ code: input.code, codeVerifier: input.codeVerifierCookie, nonce: input.nonceCookie, redirectUri: this.redirectUri() });
    this.enforcePolicy(claims);
    const user = await this.resolveUser(claims, now);
    return this.auth.createSessionForUser(user);
  }

  async cancel(state: string, stateCookie: string, nonceCookie: string): Promise<void> {
    if (!same(state, stateCookie)) return;
    const consumed = await this.infrastructure.authRepository.consumeOidcLoginState(hash(state), new Date().toISOString());
    if (consumed && !same(consumed.nonceHash, hash(nonceCookie))) throw new UnauthorizedException("OIDC sign-in state is invalid or expired.");
  }

  private enforcePolicy(claims: OidcClaims): void {
    const domains = csv(this.config.get<string>("OIDC_ALLOWED_EMAIL_DOMAINS")).map((entry) => entry.toLowerCase());
    const domain = claims.email.split("@")[1]?.toLowerCase();
    if (domains.length && (!domain || !domains.includes(domain))) throw new ForbiddenException("This email domain is not allowed to use single sign-on.");
    const allowedGroups = csv(this.config.get<string>("OIDC_ALLOWED_GROUPS"));
    if (allowedGroups.length && !claims.groups.some((group) => allowedGroups.includes(group))) throw new ForbiddenException("Your identity does not belong to an allowed group.");
  }

  private mappedRole(groups: string[]): Role {
    const mappings: Array<[Role, string[]]> = [
      ["owner", csv(this.config.get<string>("OIDC_OWNER_GROUPS"))],
      ["manager", csv(this.config.get<string>("OIDC_MANAGER_GROUPS"))],
      ["creator", csv(this.config.get<string>("OIDC_CREATOR_GROUPS"))],
    ];
    return mappings.find(([, expected]) => groups.some((group) => expected.includes(group)))?.[0] ?? (this.config.get<Role>("OIDC_DEFAULT_ROLE") ?? "viewer");
  }

  private async resolveUser(claims: OidcClaims, now: string): Promise<AuthUser> {
    const linked = await this.infrastructure.authRepository.findUserByOidcIdentity(claims.issuer, claims.subject);
    if (linked) {
      if (linked.status !== "active") throw new ForbiddenException("This account is disabled.");
      await this.infrastructure.authRepository.linkOidcIdentity({ issuer: claims.issuer, subject: claims.subject, userId: linked.id, email: claims.email, createdAt: now, lastLoginAt: now });
      return linked;
    }
    const existing = await this.infrastructure.authRepository.findUserByEmail(claims.email);
    if (existing) {
      if (existing.status !== "active") throw new ForbiddenException("This account is disabled.");
      await this.infrastructure.authRepository.linkOidcIdentity({ issuer: claims.issuer, subject: claims.subject, userId: existing.id, email: claims.email, createdAt: now, lastLoginAt: now });
      return existing;
    }
    if (this.config.get<boolean>("OIDC_AUTO_PROVISION") !== true) throw new ForbiddenException("Your account has not been invited to OriginPost.");
    const workspaceId = this.config.get<string>("OIDC_DEFAULT_WORKSPACE_ID") ?? "default";
    const workspace = await this.infrastructure.organizationRepository.getWorkspace(workspaceId);
    if (!workspace) throw new ConflictException("The OIDC default workspace is not available.");
    const user: AuthUser = { id: `user_${randomUUID()}`, email: claims.email, displayName: claims.displayName, passwordHash: "oidc-only", status: "active", createdAt: now, updatedAt: now };
    return this.infrastructure.authRepository.createOidcUserWithMembership({
      user,
      membership: { workspaceId, workspaceName: workspace.name, workspaceSlug: workspace.slug, userId: user.id, role: this.mappedRole(claims.groups), createdAt: now, updatedAt: now },
      identity: { issuer: claims.issuer, subject: claims.subject, userId: user.id, email: claims.email, createdAt: now, lastLoginAt: now },
    });
  }
}
