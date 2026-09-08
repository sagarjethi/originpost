import { randomUUID } from "node:crypto";
import { openEncryptedCredential, sealEncryptedCredential } from "@originpost/connectors";
import { createNotification, type AuditEvent, type ConnectedAccount, type ConnectedAccountRepository, type CredentialRefreshPlatform, type NotificationRepository, type OAuthRepository } from "@originpost/domain";

export interface CredentialRefreshJob {
  workspaceId: string;
  accountId: string;
  platform: CredentialRefreshPlatform;
  expectedExpiresAt: string;
  expectedCredentialRef: string;
}

export interface CredentialRefreshWorkerDependencies {
  accounts: ConnectedAccountRepository;
  oauth: OAuthRepository;
  notifications: NotificationRepository;
  credentialEncryptionKey: Buffer;
  googleClientId?: string;
  googleClientSecret?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => string;
}

type InstagramCredential = {
  provider: "instagram";
  externalAccountId: string;
  accessToken: string;
  connectionMode?: "instagram_login" | "facebook_login";
  expiresAt?: string;
  [key: string]: unknown;
};

type YouTubeCredential = {
  provider: "youtube";
  externalAccountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
  [key: string]: unknown;
};

export class CredentialRefreshError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "CredentialRefreshError";
  }
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new CredentialRefreshError("The protected provider credential is invalid. Reconnect the account.", false);
  }
}

function requireCredentialId(account: ConnectedAccount): string {
  const value = account.credentialRef;
  if (!value?.startsWith("secret:") || value.length <= 7) throw new CredentialRefreshError("This account must be reconnected before access can be renewed.", false);
  return value.slice(7);
}

function providerFailure(platform: CredentialRefreshPlatform, status: number): CredentialRefreshError {
  const retryable = status === 408 || status === 429 || status >= 500;
  const name = platform === "youtube" ? "YouTube" : "Instagram";
  return new CredentialRefreshError(retryable ? `${name} access renewal is temporarily unavailable.` : `${name} rejected the access renewal. Reconnect the account.`, retryable);
}

async function refreshYouTube(input: { credential: YouTubeCredential; clientId?: string; clientSecret?: string; fetch: typeof globalThis.fetch }): Promise<{ accessToken: string; refreshToken?: string; tokenType: string; expiresIn: number; scope?: string }> {
  if (!input.clientId || !input.clientSecret) throw new CredentialRefreshError("YouTube OAuth is not configured for automatic renewal.", false);
  let response: Response;
  try {
    response = await input.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, refresh_token: input.credential.refreshToken, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CredentialRefreshError("YouTube access renewal could not reach the provider.", true);
  }
  const value = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; token_type?: string; expires_in?: number; scope?: string };
  if (!response.ok) throw providerFailure("youtube", response.status);
  if (!value.access_token || !Number.isFinite(value.expires_in) || Number(value.expires_in) < 60) throw new CredentialRefreshError("YouTube returned an invalid access renewal response.", true);
  return { accessToken: value.access_token, ...(value.refresh_token ? { refreshToken: value.refresh_token } : {}), tokenType: value.token_type ?? "bearer", expiresIn: Number(value.expires_in), ...(value.scope ? { scope: value.scope } : {}) };
}

async function refreshInstagram(input: { credential: InstagramCredential; fetch: typeof globalThis.fetch }): Promise<{ accessToken: string; tokenType: string; expiresIn: number }> {
  if (input.credential.connectionMode === "facebook_login") throw new CredentialRefreshError("Facebook Login Instagram access must be renewed by reconnecting the account.", false);
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", input.credential.accessToken);
  let response: Response;
  try {
    response = await input.fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new CredentialRefreshError("Instagram access renewal could not reach the provider.", true);
  }
  const value = await response.json().catch(() => ({})) as { access_token?: string; token_type?: string; expires_in?: number };
  if (!response.ok) throw providerFailure("instagram", response.status);
  if (!value.access_token || !Number.isFinite(value.expires_in) || Number(value.expires_in) < 60) throw new CredentialRefreshError("Instagram returned an invalid access renewal response.", true);
  return { accessToken: value.access_token, tokenType: value.token_type ?? "bearer", expiresIn: Number(value.expires_in) };
}

async function recordFailure(job: CredentialRefreshJob, account: ConnectedAccount, error: CredentialRefreshError, attempt: number, maxAttempts: number, deps: CredentialRefreshWorkerDependencies): Promise<boolean> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const final = !error.retryable || attempt >= maxAttempts;
  const name = job.platform === "youtube" ? "YouTube" : "Instagram";
  const updated: ConnectedAccount = {
    ...account,
    status: final ? "refresh_failed" : "expiring",
    lastCheckedAt: now,
    lastErrorCode: "token_refresh",
    lastErrorStep: "Renew provider access",
    lastErrorSummary: final ? `${name} access could not be renewed. Reconnect the account.` : `${name} access renewal will retry automatically.`,
    updatedAt: now,
  };
  const audit: AuditEvent = {
    id: `audit_${randomUUID()}`,
    workspaceId: job.workspaceId,
    actorId: "originpost-worker",
    actorType: "system",
    action: final ? "channel.oauth-refresh-failed" : "channel.oauth-refresh-retry-scheduled",
    detail: { connectedAccountId: account.id, platform: job.platform, externalAccountId: account.externalAccountId, attempt, maxAttempts, retryable: error.retryable, reason: final ? "renewal_failed" : "provider_temporarily_unavailable" },
    createdAt: now,
  };
  const notification = final ? createNotification({
    workspaceId: job.workspaceId,
    kind: "connection_attention",
    severity: "warning",
    title: `${name} needs to be reconnected`,
    body: `${account.displayName} could not renew access automatically. Reconnect it before the next scheduled post.`,
    dedupeKey: `credential-refresh:${account.id}:${job.expectedExpiresAt}:failed`,
    accountId: account.id,
    actionUrl: "/?module=Channels",
    now,
  }) : undefined;
  const saved = await deps.accounts.saveCredentialRefreshResult(updated, audit, { expectedCredentialRef: job.expectedCredentialRef, expectedExpiresAt: job.expectedExpiresAt }, undefined, notification);
  if (!saved) return false;
  return true;
}

export async function processCredentialRefreshJob(job: CredentialRefreshJob, deps: CredentialRefreshWorkerDependencies, attempt = 1, maxAttempts = 5): Promise<{ skipped: boolean; reason?: string; expiresAt?: string }> {
  const account = await deps.accounts.get(job.workspaceId, job.accountId);
  if (!account) return { skipped: true, reason: "account-missing" };
  if (account.platform !== job.platform || account.status === "disconnected" || account.status === "setup_required") return { skipped: true, reason: "account-ineligible" };
  if (account.expiresAt !== job.expectedExpiresAt || account.credentialRef !== job.expectedCredentialRef) return { skipped: true, reason: "stale-refresh-job" };

  let payload: InstagramCredential | YouTubeCredential;
  let refreshed: { accessToken: string; refreshToken?: string; tokenType: string; expiresIn: number; scope?: string };
  try {
    const credentialId = requireCredentialId(account);
    const record = await deps.oauth.getCredential(job.workspaceId, credentialId);
    if (!record || record.purpose !== "provider-token") throw new CredentialRefreshError("The protected provider credential is missing. Reconnect the account.", false);
    let opened: string;
    try { opened = openEncryptedCredential(record, deps.credentialEncryptionKey); }
    catch { throw new CredentialRefreshError("The protected provider credential cannot be opened. Reconnect the account.", false); }
    const parsed = safeJson(opened);
    if (parsed.provider !== job.platform || parsed.externalAccountId !== account.externalAccountId || typeof parsed.accessToken !== "string" || !parsed.accessToken) throw new CredentialRefreshError("The provider credential does not match this connected account.", false);
    if (job.platform === "youtube") {
      if (typeof parsed.refreshToken !== "string" || !parsed.refreshToken) throw new CredentialRefreshError("The YouTube refresh grant is missing. Reconnect the account.", false);
      payload = parsed as YouTubeCredential;
      refreshed = await refreshYouTube({ credential: payload, ...(deps.googleClientId ? { clientId: deps.googleClientId } : {}), ...(deps.googleClientSecret ? { clientSecret: deps.googleClientSecret } : {}), fetch: deps.fetch ?? globalThis.fetch });
    } else {
      payload = parsed as InstagramCredential;
      refreshed = await refreshInstagram({ credential: payload, fetch: deps.fetch ?? globalThis.fetch });
    }
  } catch (cause) {
    const error = cause instanceof CredentialRefreshError ? cause : new CredentialRefreshError("Provider access renewal is temporarily unavailable.", true);
    if (!await recordFailure(job, account, error, attempt, maxAttempts, deps)) return { skipped: true, reason: "stale-refresh-result" };
    throw error;
  }

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const expiresAt = new Date(Date.parse(now) + refreshed.expiresIn * 1_000).toISOString();
  const rotatedPayload = job.platform === "youtube"
    ? { ...payload, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken ?? (payload as YouTubeCredential).refreshToken, tokenType: refreshed.tokenType, scope: refreshed.scope ?? (payload as YouTubeCredential).scope, issuedAt: now, expiresAt }
    : { ...payload, accessToken: refreshed.accessToken, tokenType: refreshed.tokenType, issuedAt: now, expiresAt };
  const secret = sealEncryptedCredential({ workspaceId: job.workspaceId, purpose: "provider-token", plaintext: JSON.stringify(rotatedPayload), key: deps.credentialEncryptionKey, now });
  const credentialId = requireCredentialId(account);
  const updated: ConnectedAccount = { ...account, credentialRef: `secret:${secret.id}`, status: "healthy", expiresAt, lastCheckedAt: now, lastHealthyAt: now, lastErrorCode: undefined, lastErrorStep: undefined, lastErrorSummary: undefined, updatedAt: now };
  const audit: AuditEvent = { id: `audit_${randomUUID()}`, workspaceId: job.workspaceId, actorId: "originpost-worker", actorType: "system", action: "channel.oauth-refreshed", detail: { connectedAccountId: account.id, platform: job.platform, externalAccountId: account.externalAccountId, expiresAt, automatic: true }, createdAt: now };
  if (!await deps.accounts.saveCredentialRefreshResult(updated, audit, { expectedCredentialRef: job.expectedCredentialRef, expectedExpiresAt: job.expectedExpiresAt }, { save: secret, deleteId: credentialId })) return { skipped: true, reason: "stale-refresh-result" };
  return { skipped: false, expiresAt };
}
