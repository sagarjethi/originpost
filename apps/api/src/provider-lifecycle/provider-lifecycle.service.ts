import { ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { can, type Actor } from "@originpost/domain";
import { resolveBrandFilter } from "../common/brand-context.js";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { parseProviderLookupKeyring, providerLookupCandidates, providerLookupHmac, type ProviderLookupKeyring } from "./provider-lookup-keyring.js";
import { verifyMetaSignedRequest } from "./meta-signed-request.js";

@Injectable()
export class ProviderLifecycleService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure, private readonly config: ConfigService) {}

  private enabled(): boolean { return String(this.config.get("META_PROVIDER_CALLBACKS_ENABLED")) === "true"; }
  private clientId(): string { return this.config.get<string>("META_APP_ID")?.trim() ?? ""; }
  private appSecret(): string { return this.config.get<string>("META_APP_SECRET")?.trim() ?? ""; }
  private statusKey(): Buffer {
    const value = this.config.get<string>("PROVIDER_DELETION_STATUS_KEY")?.trim() ?? "";
    const decoded = /^[a-f0-9]{64,}$/i.test(value) && value.length % 2 === 0 ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
    if (decoded.length < 32) throw new ServiceUnavailableException("Provider lifecycle callbacks are not configured.");
    return decoded;
  }
  private keyring(): ProviderLookupKeyring {
    try { return parseProviderLookupKeyring(this.config.get<string>("PROVIDER_LOOKUP_HMAC_KEYS") ?? "", this.config.get<string>("PROVIDER_LOOKUP_HMAC_ACTIVE_VERSION") ?? ""); }
    catch { throw new ServiceUnavailableException("Provider lifecycle callbacks are not configured."); }
  }
  private requireConfigured(): void {
    if (!this.enabled() || !this.clientId() || !this.appSecret() || this.infrastructure.storageMode !== "postgres") throw new ServiceUnavailableException("Provider lifecycle callbacks are not configured.");
  }
  private statusCode(requestId: string, nonce: string): string {
    return createHmac("sha256", this.statusKey()).update(`originpost:provider-deletion:v1\0${requestId}\0${nonce}`).digest("base64url");
  }
  private statusUrl(code: string): string {
    const origin = (this.config.get<string>("API_PUBLIC_URL") ?? "http://localhost:4000").replace(/\/$/, "");
    return `${origin}/v1/provider-data-deletions/${encodeURIComponent(code)}`;
  }
  private verify(rawBody: Buffer | undefined, contentType: string | undefined) {
    this.requireConfigured();
    try { return verifyMetaSignedRequest(rawBody, contentType, this.appSecret()); }
    catch { throw new ForbiddenException("The provider callback could not be verified."); }
  }

  async list(workspaceId: string, actor: Actor, requestedBrandId?: string) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view provider access.");
    const brandId = await resolveBrandFilter(this.infrastructure.organizationRepository, workspaceId, requestedBrandId);
    if (!brandId) return [];
    const grants = await this.infrastructure.providerLifecycleRepository.listProviderGrants(workspaceId, brandId);
    return grants.map(({ grant, accountIds }) => ({
      id: grant.id,
      provider: grant.provider,
      authorizationKind: grant.authorizationKind,
      status: grant.status,
      scopes: [...grant.scopes],
      version: grant.version,
      accountIds: [...accountIds],
      ...(grant.accessExpiresAt ? { accessExpiresAt: grant.accessExpiresAt } : {}),
      ...(grant.dataAccessExpiresAt ? { dataAccessExpiresAt: grant.dataAccessExpiresAt } : {}),
      ...(grant.nextRefreshAt ? { nextRefreshAt: grant.nextRefreshAt } : {}),
      ...(grant.nextValidationAt ? { nextValidationAt: grant.nextValidationAt } : {}),
      ...(grant.lastCheckedAt ? { lastCheckedAt: grant.lastCheckedAt } : {}),
      ...(grant.lastHealthyAt ? { lastHealthyAt: grant.lastHealthyAt } : {}),
      ...(grant.lastErrorCode ? { lastErrorCode: grant.lastErrorCode } : {}),
      ...(grant.lastErrorSummary ? { lastErrorSummary: grant.lastErrorSummary } : {}),
      updatedAt: grant.updatedAt,
    }));
  }

  async receiveMetaDeauthorization(rawBody: Buffer | undefined, contentType: string | undefined) {
    const verified = this.verify(rawBody, contentType);
    const keyring = this.keyring();
    const lookup = providerLookupHmac(keyring, "meta", this.clientId(), verified.userId);
    await this.infrastructure.providerLifecycleRepository.receiveMetaDeauthorization({ id: `provider_receipt_${randomUUID()}`, clientId: this.clientId(), lookupKeyVersion: lookup.version, subjectLookupHmac: lookup.digest, lookupCandidates: providerLookupCandidates(keyring, "meta", this.clientId(), verified.userId), payloadSha256: verified.payloadSha256, receivedAt: new Date().toISOString() });
    return { accepted: true as const };
  }

  async receiveMetaDataDeletion(rawBody: Buffer | undefined, contentType: string | undefined) {
    const verified = this.verify(rawBody, contentType);
    const keyring = this.keyring();
    const lookup = providerLookupHmac(keyring, "meta", this.clientId(), verified.userId);
    const requestId = `provider_deletion_${randomUUID()}`;
    const nonce = randomBytes(24).toString("base64url");
    const code = this.statusCode(requestId, nonce);
    const result = await this.infrastructure.providerLifecycleRepository.receiveMetaDataDeletion({ receiptId: `provider_receipt_${randomUUID()}`, requestId, clientId: this.clientId(), lookupKeyVersion: lookup.version, subjectLookupHmac: lookup.digest, lookupCandidates: providerLookupCandidates(keyring, "meta", this.clientId(), verified.userId), payloadSha256: verified.payloadSha256, confirmationNonce: nonce, confirmationCodeSha256: createHash("sha256").update(code).digest("hex"), receivedAt: new Date().toISOString() });
    const stableCode = this.statusCode(result.request.id, result.request.confirmationNonce);
    return { url: this.statusUrl(stableCode), confirmation_code: stableCode };
  }

  async deletionStatus(code: string) {
    if (!/^[A-Za-z0-9_-]{40,120}$/.test(code)) throw new NotFoundException("Deletion request not found.");
    const request = await this.infrastructure.providerLifecycleRepository.getDataDeletionByConfirmationSha256(createHash("sha256").update(code).digest("hex"));
    if (!request) throw new NotFoundException("Deletion request not found.");
    return { status: request.status === "processing" ? "pending" as const : request.status, requestedAt: request.requestedAt, ...(request.completedAt ? { completedAt: request.completedAt } : {}) };
  }
}
