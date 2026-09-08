import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { normalizeContentImportRow, type Actor, type AutomationApiKey, type AutomationEvent, type AutomationImportRow, type AutomationImportSession, type AutomationScope, type AutomationWebhookSubscription, type ContentItem } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { ContentService } from "../content/content.service.js";
import type { PublicCreateContentDto, PublicDraftDto, PublicImportPreviewDto, PublicRescheduleDto, PublicScheduleDto, CreateAutomationKeyDto, CreateAutomationSubscriptionDto } from "./automation.dto.js";
import { AutomationSecretVaultService } from "./automation-secret-vault.service.js";
import { roleForAutomationKey } from "./automation-key.guard.js";

const publicSchemaVersion = "2026-08-29";
const privateNetworks = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^::1$/i, /^fc/i, /^fd/i, /^fe80:/i];

function audit(workspaceId: string, actor: Actor, action: string, detail: Record<string, unknown>) {
  return { id: `audit_${randomUUID()}`, workspaceId, actorId: actor.id, actorType: actor.actorType ?? "human" as const, action, detail, createdAt: new Date().toISOString() };
}
function safeKey(value: AutomationApiKey) { const { secretHash: _secretHash, ...visible } = value; return visible }
function safeSubscription(value: AutomationWebhookSubscription) { const { secret: _secret, ...visible } = value; return visible }
function deterministicId(prefix: string, ...values: string[]) { return `${prefix}_${createHash("sha256").update(values.join(":"), "utf8").digest("hex").slice(0, 32)}` }
function isPrivateAddress(address: string) { return privateNetworks.some((pattern) => pattern.test(address)) }

async function readResponseBody(response: Response, maxBytes = 65_536) {
  if (!response.body) return "";
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (size < maxBytes) { const { value, done } = await reader.read(); if (done) break; if (!value) continue; const remaining = maxBytes - size; chunks.push(value.byteLength > remaining ? value.slice(0, remaining) : value); size += Math.min(value.byteLength, remaining); if (value.byteLength > remaining) { await reader.cancel(); break } }
  return Buffer.concat(chunks).toString("utf8");
}

function parseCsv(input: string): Record<string, unknown>[] {
  const table: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < input.length; index += 1) { const char = input[index]!; const next = input[index + 1]; if (quoted && char === '"' && next === '"') { field += '"'; index += 1 } else if (char === '"') quoted = !quoted; else if (!quoted && char === ",") { row.push(field); field = "" } else if (!quoted && (char === "\n" || char === "\r")) { if (char === "\r" && next === "\n") index += 1; row.push(field); field = ""; if (row.some((value) => value.trim())) table.push(row); row = [] } else field += char }
  if (quoted) throw new BadRequestException("The CSV has an unclosed quote."); row.push(field); if (row.some((value) => value.trim())) table.push(row);
  if (table.length < 2) throw new BadRequestException("CSV needs one header row and at least one data row.");
  const headers = table[0]!.map((value) => value.trim()); const allowed = new Set(["externalRef", "title", "summary", "researchDepth", "riskLevel"]); if (!headers.includes("externalRef") || !headers.includes("title") || headers.some((value) => !allowed.has(value))) throw new BadRequestException("CSV headers must include externalRef and title. Optional headers: summary, researchDepth, riskLevel.");
  return table.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

@Injectable()
export class AutomationService {
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    private readonly content: ContentService,
    private readonly vault: AutomationSecretVaultService,
    private readonly config: ConfigService,
  ) {}

  private requireManager(actor: Actor) { if (actor.role !== "owner" && actor.role !== "manager") throw new ForbiddenException("Only a manager or owner can view automation settings.") }
  private requireOwner(actor: Actor) { if (actor.role !== "owner") throw new ForbiddenException("Only a workspace owner can change API keys or webhooks.") }
  private requireScope(key: AutomationApiKey, scope: AutomationScope) { if (!key.scopes.includes(scope)) throw new ForbiddenException(`This API key does not have ${scope}.`) }
  private actor(key: AutomationApiKey): Actor { return { id: `api_key:${key.id}`, name: key.name, role: roleForAutomationKey(key), actorType: "api_key" } }

  private async assertBrand(key: AutomationApiKey, brandId: string) {
    if (key.brandIds.length && !key.brandIds.includes(brandId)) throw new ForbiddenException("This API key cannot access that brand.");
    const brand = await this.infrastructure.organizationRepository.getBrand(key.workspaceId, brandId);
    if (!brand || brand.status !== "active") throw new NotFoundException("Active brand not found for this API key.");
  }

  private assertAccount(key: AutomationApiKey, accountId: string) { if (key.accountIds.length && !key.accountIds.includes(accountId)) throw new ForbiddenException("This API key cannot use that publishing account.") }

  private async assertSafeWebhookUrl(raw: string) {
    let url: URL; try { url = new URL(raw) } catch { throw new BadRequestException("Use a valid webhook URL.") }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new BadRequestException("Webhook URLs must use HTTP(S) without credentials or fragments.");
    const allowPrivate = this.config.get<boolean>("AUTOMATION_ALLOW_PRIVATE_WEBHOOKS") === true;
    if (this.config.get<string>("NODE_ENV") === "production" && url.protocol !== "https:") throw new BadRequestException("Production webhook URLs must use HTTPS.");
    if (!allowPrivate && ["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())) throw new BadRequestException("Private or local webhook destinations are blocked.");
    if (!allowPrivate && isIP(url.hostname) && isPrivateAddress(url.hostname)) throw new BadRequestException("Private or local webhook destinations are blocked.");
    if (!allowPrivate) {
      try { const addresses = await lookup(url.hostname, { all: true, verbatim: true }); if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new BadRequestException("Private or local webhook destinations are blocked.") }
      catch (error) { if (error instanceof BadRequestException) throw error; throw new BadRequestException("The webhook hostname could not be verified.") }
    }
    return url.toString();
  }

  async listKeys(workspaceId: string, actor: Actor) { this.requireManager(actor); return (await this.infrastructure.automationRepository.listApiKeys(workspaceId)).map(safeKey) }
  async createKey(workspaceId: string, dto: CreateAutomationKeyDto, actor: Actor) {
    this.requireOwner(actor);
    if (dto.expiresAt && new Date(dto.expiresAt) <= new Date()) throw new BadRequestException("Choose an API key expiry in the future.");
    for (const brandId of dto.brandIds) { const brand = await this.infrastructure.organizationRepository.getBrand(workspaceId, brandId); if (!brand || brand.status !== "active") throw new BadRequestException(`Brand ${brandId} is not active in this workspace.`) }
    for (const accountId of dto.accountIds) { const account = await this.infrastructure.connectedAccountRepository.get(workspaceId, accountId); if (!account || (dto.brandIds.length && !dto.brandIds.includes(account.brandId))) throw new BadRequestException(`Publishing account ${accountId} is outside the key scope.`) }
    const now = new Date().toISOString(); const id = `api_key_${randomUUID()}`; const secret = `op_live_${randomBytes(8).toString("hex")}_${randomBytes(32).toString("base64url")}`;
    const key: AutomationApiKey = { id, workspaceId, name: dto.name.trim(), keyPrefix: secret.slice(0, 24), secretHash: createHash("sha256").update(secret).digest("hex"), scopes: dto.scopes, brandIds: dto.brandIds, accountIds: dto.accountIds, createdBy: actor.id, createdAt: now, ...(dto.expiresAt ? { expiresAt: dto.expiresAt } : {}) };
    await this.infrastructure.automationRepository.saveApiKey(key, audit(workspaceId, actor, "automation.api-key-created", { apiKeyId: id, scopes: key.scopes, brandIds: key.brandIds, accountIds: key.accountIds, expiresAt: key.expiresAt }));
    return { key: safeKey(key), secret };
  }
  async revokeKey(workspaceId: string, id: string, actor: Actor) { this.requireOwner(actor); const revoked = await this.infrastructure.automationRepository.revokeApiKey(workspaceId, id, new Date().toISOString(), audit(workspaceId, actor, "automation.api-key-revoked", { apiKeyId: id })); if (!revoked) throw new NotFoundException("API key not found."); return safeKey(revoked) }

  async listSubscriptions(workspaceId: string, actor: Actor) { this.requireManager(actor); return (await this.infrastructure.automationRepository.listSubscriptions(workspaceId)).map(safeSubscription) }
  async createSubscription(workspaceId: string, dto: CreateAutomationSubscriptionDto, actor: Actor) {
    this.requireOwner(actor); const url = await this.assertSafeWebhookUrl(dto.url);
    for (const brandId of dto.brandIds) { const brand = await this.infrastructure.organizationRepository.getBrand(workspaceId, brandId); if (!brand || brand.status !== "active") throw new BadRequestException(`Brand ${brandId} is not active in this workspace.`) }
    const now = new Date().toISOString(); const id = `webhook_${randomUUID()}`; const signingSecret = `whsec_${randomBytes(32).toString("base64url")}`;
    const subscription: AutomationWebhookSubscription = { id, workspaceId, name: dto.name.trim(), url, topics: dto.topics, brandIds: dto.brandIds, secret: this.vault.seal(workspaceId, id, signingSecret), active: true, createdBy: actor.id, createdAt: now, updatedAt: now };
    await this.infrastructure.automationRepository.saveSubscription(subscription, audit(workspaceId, actor, "automation.webhook-created", { subscriptionId: id, topics: dto.topics, brandIds: dto.brandIds, url }));
    return { subscription: safeSubscription(subscription), signingSecret };
  }
  async disableSubscription(workspaceId: string, id: string, actor: Actor) { this.requireOwner(actor); const disabled = await this.infrastructure.automationRepository.disableSubscription(workspaceId, id, new Date().toISOString(), audit(workspaceId, actor, "automation.webhook-disabled", { subscriptionId: id })); if (!disabled) throw new NotFoundException("Webhook subscription not found."); return safeSubscription(disabled) }
  async sendTestEvent(workspaceId: string, id: string, actor: Actor) { this.requireManager(actor); const subscription = await this.infrastructure.automationRepository.getSubscription(workspaceId, id); if (!subscription || !subscription.active) throw new NotFoundException("Active webhook subscription not found."); const event: AutomationEvent = { id: `automation_test_${randomUUID()}`, workspaceId, topic: "system.test", occurredAt: new Date().toISOString(), actorType: actor.actorType ?? "human", payload: { message: "OriginPost webhook test", subscriptionId: id } }; await this.infrastructure.automationRepository.recordTestEvent(event, id); return event }
  async listEvents(workspaceId: string, actor: Actor, limit = 100) { this.requireManager(actor); return this.infrastructure.automationRepository.listEvents(workspaceId, limit) }
  async listDeliveries(workspaceId: string, actor: Actor, limit = 100) { this.requireManager(actor); return this.infrastructure.automationRepository.listDeliveries(workspaceId, limit) }
  async retryDelivery(workspaceId: string, id: string, actor: Actor) { this.requireManager(actor); const record = await this.infrastructure.automationRepository.getDelivery(id); if (!record || record.delivery.workspaceId !== workspaceId) throw new NotFoundException("Webhook delivery not found."); if (!record.subscription.active) throw new ConflictException("Enable or replace the webhook before retrying this delivery."); const retried = await this.infrastructure.automationRepository.retryDelivery(workspaceId, id, new Date().toISOString()); if (!retried) throw new ConflictException("Only a failed or dead-letter delivery can be retried."); return { id, status: "pending" } }

  async publicList(key: AutomationApiKey, brandId?: string) { this.requireScope(key, "content:read"); if (brandId) await this.assertBrand(key, brandId); const items = await this.infrastructure.repository.list(key.workspaceId, brandId); return { data: key.brandIds.length ? items.filter((item) => key.brandIds.includes(item.brandId)) : items } }
  async publicGet(key: AutomationApiKey, id: string) { this.requireScope(key, "content:read"); const item = await this.content.get(key.workspaceId, id); await this.assertBrand(key, item.brandId); return { data: item } }
  async publicCreate(key: AutomationApiKey, dto: PublicCreateContentDto, idempotencyKey: string) {
    this.requireScope(key, "content:write"); await this.assertBrand(key, dto.brandId);
    const contentId = deterministicId("content_auto", key.workspaceId, key.id, "create", idempotencyKey); const existing = await this.infrastructure.repository.get(key.workspaceId, contentId);
    if (existing) { const matches = existing.brandId === dto.brandId && existing.title === dto.title.trim() && existing.summary === (dto.summary?.trim() ?? "") && existing.researchDepth === (dto.researchDepth ?? "standard") && existing.riskLevel === (dto.riskLevel ?? "low"); if (!matches) throw new ConflictException("This Idempotency-Key was already used with different content."); return { data: existing, meta: { idempotentReplay: true } } }
    const item = await this.content.create({ ...dto, workspaceId: key.workspaceId, contentId }, this.actor(key)); return { data: item, meta: { idempotentReplay: false } };
  }
  async publicDraft(key: AutomationApiKey, id: string, dto: PublicDraftDto, expectedVersion?: number) { this.requireScope(key, "content:write"); const current = await this.content.get(key.workspaceId, id); await this.assertBrand(key, current.brandId); return { data: await this.content.addDraft(key.workspaceId, id, dto, this.actor(key), expectedVersion) } }
  async publicSubmit(key: AutomationApiKey, id: string, expectedVersion?: number) { this.requireScope(key, "content:write"); const current = await this.content.get(key.workspaceId, id); await this.assertBrand(key, current.brandId); return { data: await this.content.transition(key.workspaceId, id, { to: "review", reason: "Submitted through the Automation Gateway" }, this.actor(key), expectedVersion) } }
  async publicSchedule(key: AutomationApiKey, id: string, dto: PublicScheduleDto, idempotencyKey: string, expectedVersion?: number) {
    this.requireScope(key, "content:schedule"); this.assertAccount(key, dto.accountId); const current = await this.content.get(key.workspaceId, id); await this.assertBrand(key, current.brandId);
    const account = await this.infrastructure.connectedAccountRepository.get(key.workspaceId, dto.accountId); if (!account || account.brandId !== current.brandId) throw new ForbiddenException("The publishing account is outside this content brand.");
    const targetId = deterministicId("target_auto", key.workspaceId, key.id, id, "schedule", idempotencyKey); const existingTarget = current.targets.find((target) => target.id === targetId); if (existingTarget) { const matches = existingTarget.platform === dto.platform && existingTarget.accountId === dto.accountId && existingTarget.draftId === dto.draftId && existingTarget.scheduledFor === dto.scheduledFor && existingTarget.deliveryMode === (dto.deliveryMode ?? "auto_publish"); if (!matches) throw new ConflictException("This Idempotency-Key was already used with a different schedule."); return { data: current, meta: { idempotentReplay: true } } }
    const item = await this.content.schedule(key.workspaceId, id, { ...dto, targetId }, this.actor(key), expectedVersion); return { data: item, meta: { idempotentReplay: false } };
  }
  async publicReschedule(key: AutomationApiKey, id: string, targetId: string, dto: PublicRescheduleDto, expectedVersion?: number) { this.requireScope(key, "content:schedule"); const current = await this.content.get(key.workspaceId, id); await this.assertBrand(key, current.brandId); return { data: await this.content.reschedule(key.workspaceId, id, targetId, dto, this.actor(key), expectedVersion) } }
  async publicCancel(key: AutomationApiKey, id: string, targetId: string, expectedVersion?: number) { this.requireScope(key, "content:schedule"); const current = await this.content.get(key.workspaceId, id); await this.assertBrand(key, current.brandId); return { data: await this.content.cancel(key.workspaceId, id, targetId, this.actor(key), expectedVersion) } }
  async publicProofs(key: AutomationApiKey, id: string) { this.requireScope(key, "proof:read"); const item = await this.content.get(key.workspaceId, id); await this.assertBrand(key, item.brandId); return { data: item.proofs, meta: { contentItemId: item.id, version: item.version, status: item.status } } }

  async previewImport(key: AutomationApiKey, dto: PublicImportPreviewDto) {
    this.requireScope(key, "imports:write"); await this.assertBrand(key, dto.brandId);
    const rawRows = dto.format === "csv" ? parseCsv(dto.data ?? "") : dto.rows?.map((value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
    if (!rawRows?.length) throw new BadRequestException(`${dto.format.toUpperCase()} import needs at least one row.`); if (rawRows.length > 100) throw new BadRequestException("An import can contain at most 100 rows.");
    const rows = rawRows.map((value, index) => normalizeContentImportRow(value, index + 1)); const seen = new Set<string>(); for (const row of rows) if (row.externalRef) { if (seen.has(row.externalRef)) { row.errors.push("externalRef is repeated in this import."); row.status = "invalid" } seen.add(row.externalRef) }
    const sourceSha256 = createHash("sha256").update(JSON.stringify({ format: dto.format, brandId: dto.brandId, rows: rawRows })).digest("hex"); const id = deterministicId("import", key.workspaceId, key.id, sourceSha256); const existing = await this.infrastructure.automationRepository.getImportSession(key.workspaceId, id); if (existing) return { data: existing, meta: { idempotentReplay: true } };
    const now = new Date().toISOString(); const session: AutomationImportSession = { id, workspaceId: key.workspaceId, apiKeyId: key.id, brandId: dto.brandId, format: dto.format, sourceSha256, status: "staged", rows, createdAt: now, updatedAt: now }; await this.infrastructure.automationRepository.saveImportSession(session); return { data: session, meta: { idempotentReplay: false } };
  }
  async getImport(key: AutomationApiKey, id: string) { this.requireScope(key, "imports:write"); const session = await this.infrastructure.automationRepository.getImportSession(key.workspaceId, id); if (!session || session.apiKeyId !== key.id) throw new NotFoundException("Import session not found for this API key."); await this.assertBrand(key, session.brandId); return { data: session } }
  async commitImport(key: AutomationApiKey, id: string) {
    this.requireScope(key, "imports:write");
    const existing = await this.infrastructure.automationRepository.getImportSession(key.workspaceId, id);
    if (!existing || existing.apiKeyId !== key.id) throw new NotFoundException("Import session not found for this API key.");
    await this.assertBrand(key, existing.brandId);
    if (existing.status === "committed") return { data: existing, meta: { idempotentReplay: true } };
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
    const claimed = await this.infrastructure.automationRepository.claimImportSession(key.workspaceId, id, key.id, now, staleBefore);
    if (!claimed) throw new ConflictException("This import is already being committed. Try again shortly.");
    const rows: AutomationImportRow[] = [];
    try {
      for (const row of claimed.rows) {
        if (row.status === "invalid") { rows.push(row); continue }
        const contentId = deterministicId("content_import", key.workspaceId, key.id, claimed.id, row.externalRef);
        const found = await this.infrastructure.repository.get(key.workspaceId, contentId);
        if (found) { rows.push({ ...row, status: "existing", contentItemId: contentId }); continue }
        try {
          await this.content.create({ workspaceId: key.workspaceId, brandId: claimed.brandId, contentId, title: row.title, summary: row.summary, researchDepth: row.researchDepth, riskLevel: row.riskLevel }, this.actor(key));
          rows.push({ ...row, status: "created", contentItemId: contentId });
        } catch (error) {
          rows.push({ ...row, status: "failed", errors: [...row.errors, error instanceof Error ? error.message : "Could not create this row."] });
        }
      }
      const completed = await this.infrastructure.automationRepository.completeImportSession(key.workspaceId, id, rows, new Date().toISOString());
      if (!completed) throw new ConflictException("The import lease changed before completion.");
      return { data: completed, meta: { idempotentReplay: false, created: rows.filter((row) => row.status === "created").length, existing: rows.filter((row) => row.status === "existing").length, invalid: rows.filter((row) => row.status === "invalid").length, failed: rows.filter((row) => row.status === "failed").length } };
    } catch (error) {
      await this.infrastructure.automationRepository.failImportSession(key.workspaceId, id, error instanceof Error ? error.message : "Import failed.", new Date().toISOString());
      throw error;
    }
  }

  async deliverDue() {
    const owner = `automation-delivery-${randomUUID()}`; const now = new Date().toISOString(); const claimed = await this.infrastructure.automationRepository.claimDeliveries(owner, now, 20, 60);
    for (const delivery of claimed) await this.deliverOne(delivery.id, owner).catch(() => undefined);
    return { claimed: claimed.length };
  }
  private async deliverOne(id: string, owner: string) {
    const record = await this.infrastructure.automationRepository.getDelivery(id); if (!record || !record.subscription.active) return;
    const now = new Date().toISOString();
    try {
      const url = await this.assertSafeWebhookUrl(record.subscription.url); const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ id: record.event.id, schemaVersion: publicSchemaVersion, topic: record.event.topic, occurredAt: record.event.occurredAt, workspaceId: record.event.workspaceId, brandId: record.event.brandId ?? null, contentItemId: record.event.contentItemId ?? null, aggregateVersion: record.event.aggregateVersion ?? null, data: record.event.payload });
      const secret = this.vault.open(record.subscription.workspaceId, record.subscription.id, record.subscription.secret); const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
      const response = await fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json", "user-agent": "OriginPost-Webhooks/1.0", "x-originpost-event-id": record.event.id, "x-originpost-timestamp": timestamp, "x-originpost-signature": `v1=${signature}` }, body });
      const responseText = await readResponseBody(response); const responseSha256 = createHash("sha256").update(responseText).digest("hex");
      if (response.status < 200 || response.status >= 300) throw new Error(`Webhook returned HTTP ${response.status}.`);
      await this.infrastructure.automationRepository.completeDelivery(id, owner, response.status, responseSha256, now);
    } catch (error) {
      const attempt = record.delivery.attempts; const retryAt = new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempt - 1))).toISOString();
      await this.infrastructure.automationRepository.failDelivery(id, owner, error instanceof Error ? error.message : "Webhook delivery failed.", retryAt, now, 8);
      throw error;
    }
  }
}
