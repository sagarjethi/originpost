import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";

export interface OidcAuthorizationInput {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
}

export interface OidcAuthenticationInput {
  code: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
}

export interface OidcClaims {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: true;
  displayName: string;
  groups: string[];
}

export interface OidcProvider {
  authorizationUrl(input: OidcAuthorizationInput): Promise<string>;
  authenticate(input: OidcAuthenticationInput): Promise<OidcClaims>;
}

export const OIDC_PROVIDER = Symbol("OIDC_PROVIDER");

export class DisabledOidcProvider implements OidcProvider {
  async authorizationUrl(): Promise<string> { throw new Error("OIDC is not configured."); }
  async authenticate(): Promise<OidcClaims> { throw new Error("OIDC is not configured."); }
}

type Fetcher = typeof fetch;
type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
  code_challenge_methods_supported?: string[];
};

type TokenResponse = { id_token?: string; access_token?: string; token_type?: string };

const SAFE_ID_TOKEN_ALGORITHMS = new Set(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"]);

function exactString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`OIDC ${field} is missing.`);
  return value;
}

function providerUrl(value: unknown, field: string, allowInsecureLoopback: boolean): string {
  const text = exactString(value, field);
  const url = new URL(text);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLoopback && url.protocol === "http:" && loopback)) throw new Error(`OIDC ${field} must use HTTPS${allowInsecureLoopback ? " or loopback HTTP" : ""}.`);
  if (url.username || url.password || url.hash) throw new Error(`OIDC ${field} is invalid.`);
  return url.toString();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim()))] : [];
}

function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

async function readJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error(`${label} response is too large.`);
  if (!response.ok) throw new Error(`${label} request failed with HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error(`${label} did not return JSON.`);
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} returned invalid JSON.`);
  return value as Record<string, unknown>;
}

function claimsFrom(payload: JWTPayload & Record<string, unknown>, groupsClaim: string): Partial<OidcClaims> {
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const preferredUsername = typeof payload.preferred_username === "string" ? payload.preferred_username.trim() : "";
  return {
    ...(typeof payload.iss === "string" ? { issuer: payload.iss } : {}),
    ...(typeof payload.sub === "string" ? { subject: payload.sub } : {}),
    ...(typeof payload.email === "string" ? { email: payload.email.trim().toLowerCase() } : {}),
    ...(payload.email_verified === true ? { emailVerified: true as const } : {}),
    ...(name || preferredUsername ? { displayName: name || preferredUsername } : {}),
    ...(stringList(payload[groupsClaim]).length ? { groups: stringList(payload[groupsClaim]) } : {}),
  };
}

export class DiscoveryOidcProvider implements OidcProvider {
  private discoveryCache?: { value: Discovery; expiresAt: number };
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly options: { issuer: string; clientId: string; clientSecret?: string; groupsClaim: string; allowInsecureLoopback?: boolean },
    private readonly fetcher: Fetcher = fetch,
  ) {}

  private async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    return this.fetcher(input, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(10_000) });
  }

  private async discovery(): Promise<Discovery> {
    if (this.discoveryCache && this.discoveryCache.expiresAt > Date.now()) return this.discoveryCache.value;
    const issuer = this.options.issuer;
    const issuerUrl = new URL(issuer);
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(issuerUrl.hostname);
    if ((issuerUrl.protocol !== "https:" && !(this.options.allowInsecureLoopback && issuerUrl.protocol === "http:" && loopback)) || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash) throw new Error("OIDC issuer must be a clean HTTPS URL, or loopback HTTP outside production.");
    const response = await this.fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { headers: { accept: "application/json" } });
    const document = await readJson(response, "OIDC discovery");
    if (document.issuer !== issuer) throw new Error("OIDC discovery issuer does not exactly match OIDC_ISSUER_URL.");
    const authorizationEndpoint = providerUrl(document.authorization_endpoint, "authorization_endpoint", this.options.allowInsecureLoopback === true);
    const tokenEndpoint = providerUrl(document.token_endpoint, "token_endpoint", this.options.allowInsecureLoopback === true);
    const jwksUri = providerUrl(document.jwks_uri, "jwks_uri", this.options.allowInsecureLoopback === true);
    const challengeMethods = stringList(document.code_challenge_methods_supported);
    if (challengeMethods.length && !challengeMethods.includes("S256")) throw new Error("OIDC provider does not advertise PKCE S256 support.");
    const discovery: Discovery = {
      issuer,
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: tokenEndpoint,
      jwks_uri: jwksUri,
      ...(document.userinfo_endpoint ? { userinfo_endpoint: providerUrl(document.userinfo_endpoint, "userinfo_endpoint", this.options.allowInsecureLoopback === true) } : {}),
      token_endpoint_auth_methods_supported: stringList(document.token_endpoint_auth_methods_supported),
      id_token_signing_alg_values_supported: stringList(document.id_token_signing_alg_values_supported),
      code_challenge_methods_supported: challengeMethods,
    };
    this.discoveryCache = { value: discovery, expiresAt: Date.now() + 10 * 60_000 };
    return discovery;
  }

  async authorizationUrl(input: OidcAuthorizationInput): Promise<string> {
    const metadata = await this.discovery();
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("scope", input.scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async authenticate(input: OidcAuthenticationInput): Promise<OidcClaims> {
    const metadata = await this.discovery();
    const body = new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier });
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
    const methods = metadata.token_endpoint_auth_methods_supported ?? [];
    if (this.options.clientSecret) {
      if (!methods.length || methods.includes("client_secret_basic")) headers.authorization = `Basic ${Buffer.from(`${formEncode(this.options.clientId)}:${formEncode(this.options.clientSecret)}`).toString("base64")}`;
      else if (methods.includes("client_secret_post")) { body.set("client_id", this.options.clientId); body.set("client_secret", this.options.clientSecret); }
      else throw new Error("OIDC provider does not support a configured client authentication method.");
    } else if (methods.length && !methods.includes("none")) {
      throw new Error("OIDC provider requires a client secret.");
    } else body.set("client_id", this.options.clientId);
    const tokenJson = await readJson(await this.fetch(metadata.token_endpoint, { method: "POST", headers, body }), "OIDC token");
    const token = tokenJson as TokenResponse;
    const idToken = exactString(token.id_token, "id_token");
    const supportedAlgorithms = (metadata.id_token_signing_alg_values_supported ?? []).filter((entry) => SAFE_ID_TOKEN_ALGORITHMS.has(entry));
    const algorithms = supportedAlgorithms.length ? supportedAlgorithms : ["RS256"];
    this.jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
      [customFetch]: (url, init) => this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(5_000) }),
    });
    const verified = await jwtVerify(idToken, this.jwks, { issuer: metadata.issuer, audience: this.options.clientId, algorithms, requiredClaims: ["exp", "iat", "sub", "nonce"], clockTolerance: 30, maxTokenAge: "10 minutes" });
    if (typeof verified.payload.nonce !== "string" || verified.payload.nonce !== input.nonce) throw new Error("OIDC nonce validation failed.");
    if (Array.isArray(verified.payload.aud) && verified.payload.aud.length > 1 && verified.payload.azp !== this.options.clientId) throw new Error("OIDC authorized party validation failed.");
    let claims = claimsFrom(verified.payload, this.options.groupsClaim);
    if ((!claims.email || claims.emailVerified !== true || !claims.displayName || !claims.groups?.length) && metadata.userinfo_endpoint && token.access_token) {
      if (typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer") throw new Error("OIDC token response did not return a Bearer access token.");
      const userInfo = await readJson(await this.fetch(metadata.userinfo_endpoint, { headers: { accept: "application/json", authorization: `Bearer ${token.access_token}` } }), "OIDC userinfo");
      if (userinfoSubject(userInfo) !== verified.payload.sub) throw new Error("OIDC userinfo subject does not match the ID token.");
      const additional = claimsFrom(userInfo as JWTPayload & Record<string, unknown>, this.options.groupsClaim);
      claims = {
        ...claims,
        ...(additional.email && additional.emailVerified ? { email: additional.email, emailVerified: additional.emailVerified } : {}),
        ...(additional.displayName || claims.displayName ? { displayName: additional.displayName || claims.displayName } : {}),
        ...(additional.groups?.length || claims.groups?.length ? { groups: additional.groups?.length ? additional.groups : claims.groups } : {}),
      };
    }
    if (!claims.issuer || !claims.subject || !claims.email || claims.emailVerified !== true) throw new Error("OIDC requires a verified email identity.");
    return { issuer: claims.issuer, subject: claims.subject, email: claims.email, emailVerified: true, displayName: claims.displayName || claims.email.split("@")[0]!, groups: claims.groups ?? [] };
  }
}

function userinfoSubject(value: Record<string, unknown>): string | undefined {
  return typeof value.sub === "string" ? value.sub : undefined;
}
