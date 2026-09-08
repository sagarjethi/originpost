import { createHmac } from "node:crypto";
import { openEncryptedCredential, providerLookupHmacAtVersion, type ProviderLookupKeyring } from "@originpost/connectors";
import type { ConnectedAccount, ConnectedAccountRepository, OAuthRepository, ProviderGrant, ProviderLifecycleRepository } from "@originpost/domain";

export interface ProviderGrantValidationJob {
  workspaceId: string;
  grantId: string;
  expectedVersion: number;
}

export interface ProviderGrantValidationDependencies {
  lifecycle: ProviderLifecycleRepository;
  accounts: ConnectedAccountRepository;
  oauth: OAuthRepository;
  credentialEncryptionKey: Buffer;
  metaAppId?: string;
  metaAppSecret?: string;
  metaApiVersion?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  providerLookupKeyring: ProviderLookupKeyring;
  fetch?: typeof globalThis.fetch;
  now?: () => string;
}

type ProviderCredential = {
  provider: "instagram" | "facebook" | "youtube";
  externalAccountId: string;
  accessToken: string;
  refreshToken?: string;
  connectionMode?: "instagram_login" | "facebook_login";
  accountType?: "BUSINESS" | "MEDIA_CREATOR";
};

export class ProviderGrantValidationError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code: string, readonly reauthorizationRequired = false) {
    super(message);
    this.name = "ProviderGrantValidationError";
  }
}

function providerHttpError(provider: "Meta" | "Google", status: number): ProviderGrantValidationError {
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  return new ProviderGrantValidationError(
    retryable ? `${provider} authorization validation is temporarily unavailable.` : `${provider} returned a response that needs review before access can be changed.`,
    retryable,
    retryable ? "provider_validation_unavailable" : "provider_validation_review_required",
  );
}

async function request(fetcher: typeof globalThis.fetch, provider: "Meta" | "Google", url: string | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ProviderGrantValidationError(`${provider} authorization validation could not reach the provider.`, true, "provider_validation_transport");
  }
}

function credentialId(account: ConnectedAccount): string {
  if (!account.credentialRef?.startsWith("secret:") || account.credentialRef.length <= 7) throw new ProviderGrantValidationError("A linked provider credential is missing. Review this authorization before reconnecting only the affected account.", false, "provider_credential_missing");
  return account.credentialRef.slice(7);
}

async function openCredential(account: ConnectedAccount, deps: ProviderGrantValidationDependencies): Promise<ProviderCredential> {
  const record = await deps.oauth.getCredential(account.workspaceId, credentialId(account));
  if (!record || record.purpose !== "provider-token") throw new ProviderGrantValidationError("A linked provider credential is missing. Review this authorization before reconnecting only the affected account.", false, "provider_credential_missing");
  let parsed: Partial<ProviderCredential>;
  try {
    parsed = JSON.parse(openEncryptedCredential(record, deps.credentialEncryptionKey)) as Partial<ProviderCredential>;
  } catch {
    throw new ProviderGrantValidationError("A linked provider credential cannot be opened. Review this authorization before reconnecting only the affected account.", false, "provider_credential_invalid");
  }
  if ((parsed.provider !== account.platform) || parsed.externalAccountId !== account.externalAccountId || typeof parsed.accessToken !== "string" || !parsed.accessToken) {
    throw new ProviderGrantValidationError("A linked provider credential does not match its account. Review this authorization before reconnecting only the affected account.", false, "provider_credential_mismatch");
  }
  return parsed as ProviderCredential;
}

function assertMetaConfiguration(grant: ProviderGrant, deps: ProviderGrantValidationDependencies): { appId: string; appSecret: string; apiVersion: string } {
  const appId = deps.metaAppId?.trim();
  const appSecret = deps.metaAppSecret;
  const apiVersion = deps.metaApiVersion?.trim();
  if (!appId || !appSecret || !apiVersion || !/^v\d+\.\d+$/.test(apiVersion)) throw new ProviderGrantValidationError("Meta validation is not configured on this worker.", false, "provider_validation_configuration");
  if (grant.clientId !== appId) throw new ProviderGrantValidationError("This Meta authorization belongs to a different configured application and needs operator review.", false, "provider_client_mismatch");
  return { appId, appSecret, apiVersion };
}

function assertLookupIdentity(grant: ProviderGrant, value: string, deps: ProviderGrantValidationDependencies): void {
  const expected = grant.provider === "meta" ? grant.subjectLookupHmac : grant.refreshTokenLookupHmac;
  if (!expected) throw new ProviderGrantValidationError("The authorization identity record is incomplete and needs operator review.", false, "provider_grant_identity_missing");
  let actual: string;
  try { actual = providerLookupHmacAtVersion(deps.providerLookupKeyring, grant.lookupKeyVersion, grant.provider, grant.clientId, value); }
  catch { throw new ProviderGrantValidationError("The authorization identity key version is unavailable and needs operator review.", false, "provider_lookup_key_unavailable"); }
  if (actual !== expected) throw new ProviderGrantValidationError("The protected authorization identity does not match and needs operator review.", false, "provider_grant_identity_mismatch");
}

async function validateInstagramLogin(grant: ProviderGrant, account: ConnectedAccount, credential: ProviderCredential, deps: ProviderGrantValidationDependencies): Promise<void> {
  assertMetaConfiguration(grant, deps);
  const url = new URL("https://graph.instagram.com/me");
  url.searchParams.set("fields", "user_id,username,account_type");
  const response = await request(deps.fetch ?? globalThis.fetch, "Meta", url, { headers: { authorization: `Bearer ${credential.accessToken}` } });
  const body = await response.json().catch(() => ({})) as { id?: unknown; user_id?: unknown; error?: unknown };
  if (!response.ok) throw providerHttpError("Meta", response.status);
  const providerSubject = String(body.user_id ?? body.id ?? "");
  if (body.error || providerSubject !== account.externalAccountId) throw new ProviderGrantValidationError("Instagram did not return the expected account identity. Review this account before reconnecting it.", false, "provider_identity_mismatch");
  if (credential.accountType !== "BUSINESS" && credential.accountType !== "MEDIA_CREATOR") throw new ProviderGrantValidationError("The Instagram professional-account type is missing and needs review.", false, "provider_account_type_missing");
  assertLookupIdentity(grant, providerSubject, deps);
}

async function validateFacebookLoginAccount(account: ConnectedAccount, credential: ProviderCredential, grant: ProviderGrant, deps: ProviderGrantValidationDependencies): Promise<void> {
  const { appId, appSecret, apiVersion } = assertMetaConfiguration(grant, deps);
  const fetcher = deps.fetch ?? globalThis.fetch;
  const debugResponse = await request(fetcher, "Meta", `https://graph.facebook.com/${apiVersion}/debug_token`, {
    method: "POST",
    headers: { authorization: `Bearer ${appId}|${appSecret}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ input_token: credential.accessToken }),
  });
  const debug = await debugResponse.json().catch(() => ({})) as { data?: { app_id?: unknown; user_id?: unknown; is_valid?: unknown; expires_at?: unknown; data_access_expires_at?: unknown; scopes?: unknown }; error?: unknown };
  if (!debugResponse.ok) throw providerHttpError("Meta", debugResponse.status);
  const data = debug.data;
  const nowSeconds = Math.floor(Date.parse((deps.now ?? (() => new Date().toISOString()))()) / 1_000);
  const expiresAt = typeof data?.expires_at === "number" ? data.expires_at : 0;
  const dataAccessExpiresAt = typeof data?.data_access_expires_at === "number" ? data.data_access_expires_at : 0;
  const scopes = Array.isArray(data?.scopes) ? data.scopes.filter((scope): scope is string => typeof scope === "string") : undefined;
  if (debug.error || data?.is_valid !== true || typeof data.user_id !== "string" || !data.user_id || data.app_id !== appId || (expiresAt > 0 && expiresAt <= nowSeconds) || (dataAccessExpiresAt > 0 && dataAccessExpiresAt <= nowSeconds)) throw new ProviderGrantValidationError("Meta did not return complete grant evidence. Review this authorization before reconnecting affected accounts.", false, "provider_validation_review_required");
  if (!scopes || grant.scopes.some((scope) => !scopes.includes(scope))) throw new ProviderGrantValidationError("Meta did not confirm every approved permission. Review this authorization before reconnecting affected accounts.", false, "provider_scope_review_required");
  assertLookupIdentity(grant, data.user_id, deps);

  const identityUrl = new URL(`https://graph.facebook.com/${apiVersion}/${encodeURIComponent(account.externalAccountId)}`);
  identityUrl.searchParams.set("fields", account.platform === "facebook" ? "id,tasks" : "id");
  identityUrl.searchParams.set("appsecret_proof", createHmac("sha256", appSecret).update(credential.accessToken).digest("hex"));
  identityUrl.searchParams.set("appsecret_time", String(nowSeconds));
  const identityResponse = await request(fetcher, "Meta", identityUrl, { headers: { authorization: `Bearer ${credential.accessToken}` } });
  const identity = await identityResponse.json().catch(() => ({})) as { id?: unknown; tasks?: unknown; error?: unknown };
  if (!identityResponse.ok) throw providerHttpError("Meta", identityResponse.status);
  if (identity.error || String(identity.id ?? "") !== account.externalAccountId) throw new ProviderGrantValidationError("Meta did not return this linked account. Review only the affected account before changing shared access.", false, "provider_target_review_required");
  if (account.platform === "facebook") {
    const tasks = Array.isArray(identity.tasks) ? identity.tasks.filter((task): task is string => typeof task === "string") : [];
    if (!tasks.includes("CREATE_CONTENT") || (account.capabilities.includes("analytics_read") && !tasks.includes("ANALYZE"))) throw new ProviderGrantValidationError("Meta no longer confirms the Page tasks required by this account. Review only the affected Page before changing shared access.", false, "provider_page_task_review_required");
  }
}

function assertGoogleConfiguration(grant: ProviderGrant, deps: ProviderGrantValidationDependencies): { clientId: string; clientSecret: string } {
  const clientId = deps.googleClientId?.trim();
  const clientSecret = deps.googleClientSecret;
  if (!clientId || !clientSecret) throw new ProviderGrantValidationError("Google validation is not configured on this worker.", false, "provider_validation_configuration");
  if (grant.clientId !== clientId) throw new ProviderGrantValidationError("This Google authorization belongs to a different configured client and needs operator review.", false, "provider_client_mismatch");
  return { clientId, clientSecret };
}

async function refreshedGoogleAccessToken(grant: ProviderGrant, credential: ProviderCredential, deps: ProviderGrantValidationDependencies): Promise<string> {
  const { clientId, clientSecret } = assertGoogleConfiguration(grant, deps);
  if (!credential.refreshToken) throw new ProviderGrantValidationError("The protected Google refresh grant is missing and needs review.", false, "provider_refresh_grant_missing");
  assertLookupIdentity(grant, credential.refreshToken, deps);
  const response = await request(deps.fetch ?? globalThis.fetch, "Google", "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: credential.refreshToken, grant_type: "refresh_token" }),
  });
  const body = await response.json().catch(() => ({})) as { access_token?: unknown; error?: unknown };
  if (!response.ok) {
    if (body.error === "invalid_grant") throw new ProviderGrantValidationError("Google confirmed that this refresh grant is no longer valid. Reconnect to restore access.", false, "provider_grant_revoked", true);
    throw providerHttpError("Google", response.status);
  }
  if (typeof body.access_token !== "string" || !body.access_token) throw new ProviderGrantValidationError("Google returned an incomplete refresh response that needs review.", false, "provider_validation_review_required");
  return body.access_token;
}

async function validateGoogleAccount(grant: ProviderGrant, account: ConnectedAccount, credential: ProviderCredential, deps: ProviderGrantValidationDependencies): Promise<void> {
  const accessToken = await refreshedGoogleAccessToken(grant, credential, deps);
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "id");
  url.searchParams.set("mine", "true");
  url.searchParams.set("maxResults", "50");
  const response = await request(deps.fetch ?? globalThis.fetch, "Google", url, { headers: { authorization: `Bearer ${accessToken}` } });
  const body = await response.json().catch(() => ({})) as { items?: Array<{ id?: unknown }>; error?: unknown };
  if (!response.ok) throw providerHttpError("Google", response.status);
  if (body.error || !Array.isArray(body.items) || !body.items.some((item) => item.id === account.externalAccountId)) throw new ProviderGrantValidationError("YouTube did not return this channel. Review only the affected account before changing the Google grant.", false, "provider_target_review_required");
}

async function validateAccount(grant: ProviderGrant, account: ConnectedAccount, deps: ProviderGrantValidationDependencies): Promise<void> {
  if (account.workspaceId !== grant.workspaceId || account.status === "disconnected" || account.status === "setup_required") throw new ProviderGrantValidationError("A linked account is no longer eligible for provider validation.", false, "provider_account_ineligible");
  const credential = await openCredential(account, deps);
  if (grant.provider === "google") {
    if (account.platform !== "youtube" || credential.provider !== "youtube") throw new ProviderGrantValidationError("A Google grant is linked to an invalid account type.", false, "provider_account_mismatch");
    await validateGoogleAccount(grant, account, credential, deps);
  } else if (grant.authorizationKind === "instagram_login") {
    if (account.platform !== "instagram" || credential.connectionMode === "facebook_login") throw new ProviderGrantValidationError("An Instagram Login grant is linked to an invalid account type.", false, "provider_account_mismatch");
    await validateInstagramLogin(grant, account, credential, deps);
  } else {
    if ((account.platform !== "instagram" && account.platform !== "facebook") || credential.connectionMode === "instagram_login") throw new ProviderGrantValidationError("A Facebook Login grant is linked to an invalid account type.", false, "provider_account_mismatch");
    await validateFacebookLoginAccount(account, credential, grant, deps);
  }
}

export async function processProviderGrantValidation(job: ProviderGrantValidationJob, deps: ProviderGrantValidationDependencies, attempt = 1, maxAttempts = 5): Promise<{ skipped: boolean; reason?: string; validatedAccounts?: number }> {
  const entry = (await deps.lifecycle.listProviderGrants(job.workspaceId)).find((candidate) => candidate.grant.id === job.grantId);
  if (!entry) return { skipped: true, reason: "grant-missing" };
  if (entry.grant.version !== job.expectedVersion || !["active", "expiring", "refresh_failed"].includes(entry.grant.status)) return { skipped: true, reason: "stale-validation-job" };
  const accounts = (await Promise.all(entry.accountIds.map((accountId) => deps.accounts.get(job.workspaceId, accountId)))).filter((account): account is ConnectedAccount => Boolean(account));
  try {
    if (!accounts.length || accounts.length !== entry.accountIds.length) throw new ProviderGrantValidationError("This provider grant has no complete linked-account set.", false, "provider_account_missing");
    for (const account of accounts) await validateAccount(entry.grant, account, deps);
    const checkedAt = (deps.now ?? (() => new Date().toISOString()))();
    const interval = entry.grant.provider === "google" ? 30 * 24 * 60 * 60_000 : 7 * 24 * 60 * 60_000;
    const saved = await deps.lifecycle.recordProviderGrantValidation({ workspaceId: job.workspaceId, grantId: job.grantId, expectedVersion: job.expectedVersion, outcome: "healthy", checkedAt, nextValidationAt: new Date(Date.parse(checkedAt) + interval).toISOString() });
    return saved ? { skipped: false, validatedAccounts: accounts.length } : { skipped: true, reason: "stale-validation-result" };
  } catch (cause) {
    const error = cause instanceof ProviderGrantValidationError ? cause : new ProviderGrantValidationError("Provider authorization validation is temporarily unavailable.", true, "provider_validation_unavailable");
    if (error.retryable && attempt < maxAttempts) throw error;
    const checkedAt = (deps.now ?? (() => new Date().toISOString()))();
    const outcome = error.reauthorizationRequired ? "reauthorization_required" : error.retryable ? "transient_failure" : "review_required";
    const saved = await deps.lifecycle.recordProviderGrantValidation({ workspaceId: job.workspaceId, grantId: job.grantId, expectedVersion: job.expectedVersion, outcome, checkedAt, ...(!error.reauthorizationRequired ? { nextValidationAt: new Date(Date.parse(checkedAt) + (error.retryable ? 60 * 60_000 : 24 * 60 * 60_000)).toISOString() } : {}), errorCode: error.code, errorSummary: error.message });
    return saved ? { skipped: false, validatedAccounts: 0 } : { skipped: true, reason: "stale-validation-result" };
  }
}
