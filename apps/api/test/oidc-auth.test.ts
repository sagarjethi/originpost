import { ConfigService } from "@nestjs/config";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { InMemoryAuthRepository, InMemoryOrganizationRepository, type AuthUser } from "@originpost/domain";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.service.js";
import { OidcAuthService } from "../src/auth/oidc-auth.service.js";
import { DiscoveryOidcProvider, type OidcAuthorizationInput, type OidcAuthenticationInput, type OidcClaims, type OidcProvider } from "../src/auth/oidc-provider.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";

class MockOidcProvider implements OidcProvider {
  authorization?: OidcAuthorizationInput;
  authentication?: OidcAuthenticationInput;
  constructor(private readonly claims: OidcClaims) {}
  async authorizationUrl(input: OidcAuthorizationInput): Promise<string> {
    this.authorization = input;
    return `https://identity.example.test/authorize?state=${encodeURIComponent(input.state)}`;
  }
  async authenticate(input: OidcAuthenticationInput): Promise<OidcClaims> {
    this.authentication = input;
    return this.claims;
  }
}

function fixture(overrides: Record<string, unknown> = {}, claims: Partial<OidcClaims> = {}) {
  const authRepository = new InMemoryAuthRepository();
  const organizationRepository = new InMemoryOrganizationRepository((membership) => authRepository.addWorkspaceMembership(membership));
  const infrastructure = { authRepository, organizationRepository } as unknown as OriginPostInfrastructure;
  const config = new ConfigService({
    AUTH_MODE: "sessions",
    AUTH_SESSION_DAYS: 14,
    OIDC_ENABLED: true,
    OIDC_REDIRECT_URI: "https://originpost.example.test/v1/auth/oidc/callback",
    OIDC_WEB_RETURN_URL: "https://originpost.example.test/",
    OIDC_ALLOWED_EMAIL_DOMAINS: "example.test",
    OIDC_ALLOWED_GROUPS: "originpost-users,originpost-admins",
    OIDC_OWNER_GROUPS: "originpost-admins",
    OIDC_DEFAULT_ROLE: "viewer",
    OIDC_DEFAULT_WORKSPACE_ID: "default",
    ...overrides,
  });
  const provider = new MockOidcProvider({ issuer: "https://identity.example.test", subject: "subject-1", email: "member@example.test", emailVerified: true, displayName: "OIDC Member", groups: ["originpost-users"], ...claims });
  const password = { hash: vi.fn(), verify: vi.fn() };
  const auth = new AuthService(infrastructure, password as never, config);
  const oidc = new OidcAuthService(config, infrastructure, provider, auth);
  return { authRepository, oidc, provider };
}

async function complete(oidc: OidcAuthService) {
  const start = await oidc.start();
  return oidc.callback({ code: "authorization-code", state: start.state, stateCookie: start.state, nonceCookie: start.nonce, codeVerifierCookie: start.codeVerifier });
}

describe("OIDC authentication module", () => {
  it("uses authorization code, PKCE, state, nonce and preserves an invited user's membership", async () => {
    const { authRepository, oidc, provider } = fixture();
    const now = new Date().toISOString();
    const user: AuthUser = { id: "user_invited", email: "member@example.test", displayName: "Invited Member", passwordHash: "disabled", status: "active", createdAt: now, updatedAt: now };
    await authRepository.createUserWithMembership({ user, membership: { workspaceId: "default", workspaceName: "My workspace", workspaceSlug: "my-workspace", userId: user.id, role: "manager", createdAt: now, updatedAt: now }, createdBy: "owner" });

    const result = await complete(oidc);
    expect(provider.authorization).toMatchObject({ redirectUri: "https://originpost.example.test/v1/auth/oidc/callback", scopes: expect.arrayContaining(["openid", "email", "profile"]) });
    expect(provider.authorization?.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(provider.authentication).toMatchObject({ code: "authorization-code", redirectUri: "https://originpost.example.test/v1/auth/oidc/callback" });
    expect(result).toMatchObject({ user: { id: "user_invited", email: "member@example.test" }, memberships: [expect.objectContaining({ role: "manager" })] });
    expect(await authRepository.findUserByOidcIdentity("https://identity.example.test", "subject-1")).toMatchObject({ id: "user_invited" });
  });

  it("auto-provisions only when enabled and maps a configured group for the first membership", async () => {
    const { authRepository, oidc } = fixture({ OIDC_AUTO_PROVISION: true }, { groups: ["originpost-users", "originpost-admins"] });
    const result = await complete(oidc);
    expect(result.memberships).toEqual([expect.objectContaining({ workspaceId: "default", role: "owner" })]);
    expect(await authRepository.findUserByEmail("member@example.test")).toMatchObject({ passwordHash: "oidc-only", status: "active" });
  });

  it("rejects uninvited identities by default, disallowed domains and state replay", async () => {
    const uninvited = fixture();
    await expect(complete(uninvited.oidc)).rejects.toThrow("not been invited");

    const domain = fixture({ OIDC_AUTO_PROVISION: true }, { email: "outsider@other.test" });
    await expect(complete(domain.oidc)).rejects.toThrow("domain is not allowed");

    const replay = fixture({ OIDC_AUTO_PROVISION: true });
    const start = await replay.oidc.start();
    const input = { code: "authorization-code", state: start.state, stateCookie: start.state, nonceCookie: start.nonce, codeVerifierCookie: start.codeVerifier };
    await replay.oidc.callback(input);
    await expect(replay.oidc.callback(input)).rejects.toThrow("state is invalid or expired");
  });
});

describe("OIDC discovery adapter", () => {
  it("discovers endpoints, sends PKCE and verifies the signed ID token and nonce", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const nonce = "nonce-value";
    const idToken = await new SignJWT({ email: "person@example.test", email_verified: true, name: "Person", groups: ["originpost-users"], nonce })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://identity.example.test")
      .setSubject("person-1")
      .setAudience("originpost-client")
      .setIssuedAt()
      .setExpirationTime("5 minutes")
      .sign(privateKey);
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: "https://identity.example.test", authorization_endpoint: "https://identity.example.test/authorize", token_endpoint: "https://identity.example.test/token", jwks_uri: "https://identity.example.test/jwks", token_endpoint_auth_methods_supported: ["client_secret_basic"], code_challenge_methods_supported: ["S256"], id_token_signing_alg_values_supported: ["RS256"] });
      if (url.endsWith("/token")) {
        expect(init?.method).toBe("POST");
        expect(new URLSearchParams(String(init?.body)).get("code_verifier")).toBe("a".repeat(64));
        expect((init?.headers as Record<string, string>).authorization).toMatch(/^Basic /);
        return Response.json({ id_token: idToken, access_token: "access-token", token_type: "Bearer" });
      }
      if (url.endsWith("/jwks")) return Response.json({ keys: [{ ...jwk, kid: "test-key", use: "sig", alg: "RS256" }] });
      throw new Error(`Unexpected URL ${url}`);
    });
    const provider = new DiscoveryOidcProvider({ issuer: "https://identity.example.test", clientId: "originpost-client", clientSecret: "client-secret", groupsClaim: "groups" }, fetcher as typeof fetch);
    const authorizationUrl = new URL(await provider.authorizationUrl({ state: "state", nonce, codeChallenge: "challenge", redirectUri: "https://originpost.example.test/v1/auth/oidc/callback", scopes: ["openid", "email", "profile"] }));
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("state")).toBe("state");
    const claims = await provider.authenticate({ code: "code", codeVerifier: "a".repeat(64), nonce, redirectUri: "https://originpost.example.test/v1/auth/oidc/callback" });
    expect(claims).toEqual({ issuer: "https://identity.example.test", subject: "person-1", email: "person@example.test", emailVerified: true, displayName: "Person", groups: ["originpost-users"] });
  });
});
