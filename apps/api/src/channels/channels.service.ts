import { ConflictException, ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { can, createNotification, DomainError, type Actor, type AuditEvent, type ConnectedAccount } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { resolveActiveBrand, resolveBrandFilter } from "../common/brand-context.js";
import type { CreateConnectedAccountDto, UpdateConnectedAccountDto } from "./dto/channel.dto.js";
import { ConnectionDoctorService } from "./connection-doctor.service.js";
import { CredentialVaultService } from "./credential-vault.service.js";
import { instagramStoryCapabilityView } from "./instagram-story-capability.view.js";

function visible(account: ConnectedAccount) {
  const { credentialRef: _credentialRef, ...safe } = account;
  return { ...safe, credentialConfigured: Boolean(account.credentialRef), credentialManaged: account.credentialRef?.startsWith("secret:") ?? false };
}

function event(account: ConnectedAccount, actor: Actor, action: string, detail: Record<string, unknown>): AuditEvent {
  return { id: `audit_${crypto.randomUUID()}`, workspaceId: account.workspaceId, actorId: actor.id, actorType: "human", action, detail: { connectedAccountId: account.id, platform: account.platform, ...detail }, createdAt: new Date().toISOString() };
}

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    private readonly doctor: ConnectionDoctorService,
    private readonly vault: CredentialVaultService,
    private readonly config: ConfigService,
  ) {}

  private async accountView(account: ConnectedAccount) {
    const safe = visible(account);
    if (account.platform !== "instagram") return safe;

    let credentialPayload: unknown;
    if (account.credentialRef?.startsWith("secret:")) {
      try {
        credentialPayload = JSON.parse(await this.vault.open(account.workspaceId, account.credentialRef.slice(7)));
      } catch {
        // A missing or unreadable protected identity must fail closed. The UI
        // gets no vault error details or credential fields.
      }
    }

    return {
      ...safe,
      instagramStory: instagramStoryCapabilityView(account.externalAccountId, credentialPayload),
    };
  }

  async list(workspaceId: string, actor: Actor, requestedBrandId?: string) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view channels.");
    const brandId = await resolveBrandFilter(this.infrastructure.organizationRepository, workspaceId, requestedBrandId);
    if (!brandId) return [];
    return Promise.all((await this.infrastructure.connectedAccountRepository.list(workspaceId, brandId)).map(async (account) => ({ ...(await this.accountView(account)), diagnostic: await this.doctor.inspect(account) })));
  }

  private async require(workspaceId: string, id: string) {
    const account = await this.infrastructure.connectedAccountRepository.get(workspaceId, id);
    if (!account) throw new DomainError("Connected account not found.", "connected_account_not_found", 404);
    return account;
  }

  async create(dto: CreateConnectedAccountDto, actor: Actor) {
    if (!can(actor.role, "workspace:manage")) throw new ForbiddenException("Only workspace owners can connect accounts.");
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, dto.workspaceId, dto.brandId);
    const duplicate = (await this.infrastructure.connectedAccountRepository.list(dto.workspaceId)).some((account) => account.platform === dto.platform && account.externalAccountId === dto.externalAccountId);
    if (duplicate) throw new ConflictException("This provider account is already connected in the workspace.");
    const now = new Date().toISOString();
    const account: ConnectedAccount = {
      id: `account_${crypto.randomUUID()}`, workspaceId: dto.workspaceId, brandId, platform: dto.platform,
      displayName: dto.displayName.trim(), externalAccountId: dto.externalAccountId.trim(),
      ...(dto.credentialRef ? { credentialRef: dto.credentialRef } : {}), capabilities: [...new Set(dto.capabilities)],
      status: "setup_required", ...(dto.expiresAt ? { expiresAt: dto.expiresAt } : {}),
      createdBy: actor.id, createdAt: now, updatedAt: now,
    };
    await this.infrastructure.connectedAccountRepository.save(account, event(account, actor, "channel.account-created", { credentialConfigured: Boolean(account.credentialRef), capabilities: account.capabilities }));
    return this.check(dto.workspaceId, account.id, actor);
  }

  async update(workspaceId: string, id: string, dto: UpdateConnectedAccountDto, actor: Actor) {
    if (!can(actor.role, "workspace:manage")) throw new ForbiddenException("Only workspace owners can update accounts.");
    const current = await this.require(workspaceId, id);
    const updated: ConnectedAccount = {
      ...current,
      ...(dto.displayName ? { displayName: dto.displayName.trim() } : {}),
      ...(dto.externalAccountId ? { externalAccountId: dto.externalAccountId.trim() } : {}),
      ...(dto.credentialRef ? { credentialRef: dto.credentialRef } : {}),
      ...(dto.capabilities ? { capabilities: [...new Set(dto.capabilities)] } : {}),
      ...(dto.expiresAt ? { expiresAt: dto.expiresAt } : {}),
      status: current.status === "disconnected" ? "setup_required" : current.status,
      updatedAt: new Date().toISOString(),
    };
    await this.infrastructure.connectedAccountRepository.save(updated, event(updated, actor, "channel.account-updated", { credentialConfigured: Boolean(updated.credentialRef), capabilities: updated.capabilities }));
    return this.check(workspaceId, id, actor);
  }

  async check(workspaceId: string, id: string, actor: Actor) {
    if (!can(actor.role, "workspace:manage")) throw new ForbiddenException("Only workspace owners can check account connections.");
    const current = await this.require(workspaceId, id);
    const diagnostic = await this.doctor.inspect(current);
    if (current.status === "disconnected") return { ...(await this.accountView(current)), diagnostic };
    const firstFailure = diagnostic.checks.find((check) => check.status === "fail");
    const expiryFailed = firstFailure?.id === "expiry";
    const status: ConnectedAccount["status"] = diagnostic.readiness === "blocked" ? (expiryFailed ? "refresh_failed" : "setup_required") : diagnostic.readiness === "warning" && diagnostic.checks.some((check) => check.id === "expiry" && check.status === "warn") ? "expiring" : "healthy";
    const updated: ConnectedAccount = {
      ...current, status, lastCheckedAt: diagnostic.checkedAt,
      ...(diagnostic.readiness !== "blocked" ? { lastHealthyAt: diagnostic.checkedAt } : {}),
      ...(firstFailure ? { lastErrorCode: firstFailure.id, lastErrorStep: firstFailure.label, lastErrorSummary: firstFailure.detail } : { lastErrorCode: undefined, lastErrorStep: undefined, lastErrorSummary: undefined }),
      updatedAt: diagnostic.checkedAt,
    };
    await this.infrastructure.connectedAccountRepository.save(updated, event(updated, actor, "channel.connection-checked", { readiness: diagnostic.readiness, failedStep: firstFailure?.id ?? null }));
    if (status === "expiring" || status === "refresh_failed" || diagnostic.readiness === "blocked") {
      await this.infrastructure.notificationRepository.create(createNotification({
        workspaceId,
        kind: "connection_attention",
        severity: status === "expiring" ? "warning" : "error",
        title: `${updated.displayName} needs attention`,
        body: firstFailure?.detail ?? "Run Connection Doctor and fix this account before the next scheduled post.",
        dedupeKey: `account:${updated.id}:${status}:${firstFailure?.id ?? "unknown"}:${diagnostic.checkedAt.slice(0, 10)}`,
        accountId: updated.id,
        actionUrl: "/?module=Channels",
      })).catch((error) => this.logger.error("Could not create connection notification", error));
    }
    return { ...(await this.accountView(updated)), diagnostic };
  }

  async disconnect(workspaceId: string, id: string, actor: Actor) {
    if (!can(actor.role, "workspace:manage")) throw new ForbiddenException("Only workspace owners can disconnect accounts.");
    const current = await this.require(workspaceId, id);
    const encryptedCredentialId = current.credentialRef?.startsWith("secret:") ? current.credentialRef.slice(7) : undefined;
    const locallyDisconnected: ConnectedAccount = {
      ...current,
      ...(current.platform === "youtube" ? { displayName: "Disconnected YouTube channel", externalAccountId: `revoked:${current.id}` } : {}),
      status: "disconnected", lastErrorCode: undefined, lastErrorStep: undefined, lastErrorSummary: undefined, updatedAt: new Date().toISOString(),
    };
    const metaGrantStatus=current.platform==="instagram"||current.platform==="facebook"?"provider_deauthorization_required" as const:undefined;
    await this.infrastructure.connectedAccountRepository.save(locallyDisconnected, event(locallyDisconnected, actor, "channel.account-disconnect-requested", { providerRevocationRequired: Boolean(metaGrantStatus)||(current.platform === "youtube" && Boolean(encryptedCredentialId)),...(metaGrantStatus?{remoteGrantStatus:metaGrantStatus}:{}) }));

    if (current.platform === "youtube" && encryptedCredentialId) {
      try {
        await this.revokeYouTube(workspaceId, encryptedCredentialId);
      } catch (cause) {
        const pending: ConnectedAccount = {
          ...locallyDisconnected,
          lastErrorCode: "provider_revocation_pending",
          lastErrorStep: "Google access removal",
          lastErrorSummary: cause instanceof Error ? cause.message : "Google access removal is pending.",
          updatedAt: new Date().toISOString(),
        };
        await this.infrastructure.connectedAccountRepository.save(pending, event(pending, actor, "channel.provider-revocation-pending", { provider: "youtube" }));
        await this.infrastructure.notificationRepository.create(createNotification({
          workspaceId,
          kind: "connection_attention",
          severity: "warning",
          title: "Google access removal is still pending",
          body: pending.lastErrorSummary ?? "Publishing is blocked locally. Retry the Google cleanup from Channels.",
          dedupeKey: `account:${pending.id}:provider-revocation-pending`,
          accountId: pending.id,
          actionUrl: "/?module=Channels",
        })).catch((error) => this.logger.error("Could not create revocation notification", error));
        return { ...(await this.accountView(pending)), remoteGrantStatus: "revocation_pending" as const };
      }
    }

    const completed: ConnectedAccount = {
      ...locallyDisconnected,
      credentialRef: undefined,
      lastErrorCode: undefined,
      lastErrorStep: undefined,
      lastErrorSummary: undefined,
      updatedAt: new Date().toISOString(),
    };
    const remoteGrantStatus=metaGrantStatus??(current.platform==="youtube"&&encryptedCredentialId?"revoked":"not_managed");
    await this.infrastructure.connectedAccountRepository.save(completed, event(completed, actor, "channel.account-disconnected", { remoteGrantStatus,providerRevoked:remoteGrantStatus==="revoked" }), encryptedCredentialId ? { deleteId: encryptedCredentialId } : undefined, { unlink: true });
    return { ...(await this.accountView(completed)), remoteGrantStatus };
  }

  private async revokeYouTube(workspaceId: string, credentialId: string): Promise<void> {
    if (this.config.get<string>("NODE_ENV") === "test" && this.config.get<string>("OAUTH_TEST_MODE") === "true") return;
    let token: string | undefined;
    try {
      const payload = JSON.parse(await this.vault.open(workspaceId, credentialId)) as { provider?: string; refreshToken?: string; accessToken?: string };
      if (payload.provider === "youtube") token = payload.refreshToken ?? payload.accessToken;
    } catch {
      throw new Error("The protected YouTube grant could not be opened. Remove OriginPost through Google Account permissions, then retry here.");
    }
    if (!token) throw new Error("The protected YouTube grant has no revocable token. Remove OriginPost through Google Account permissions, then retry here.");
    const response = await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Google did not confirm access removal. Publishing is blocked locally; retry here or remove OriginPost through Google Account permissions.");
  }
}
