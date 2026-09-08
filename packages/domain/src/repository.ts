import { DomainError } from "./errors.js";
import { transitionEngagementAction } from "./engagement.js";
import type { ActionTransition, BrandScope, CommentIngestBatch, EngagementAction, EngagementActionStatus, EngagementComment, EngagementRepository, EngagementThread, EngagementThreadUpdate, EngagementThreadView, EngagementWebhookReceipt, InboxPage, InboxQuery, IngestResult, ReadMarker } from "./engagement.js";
import type { WorkspaceMembership } from "./auth.js";
import type { InstagramPublishSettings } from "./instagram-collaboration.js";
import { assertScheduleConflictAcknowledgement, inspectScheduleConflicts, type ScheduleConflictCommit } from "./schedule-conflicts.js";
import type { CreativeStudioRepository } from "./creative-studio.js";
import type { AutomationRepository } from "./automation.js";
import type { AnalyticsReportDefinition, AnalyticsReportRepository, AnalyticsReportShare, AnalyticsReportSnapshot } from "./analytics-reporting.js";
import type { AnalyticsRepository, AuditEvent, Brand, ConnectedAccount, ConnectedAccountRepository, ContentItem, ContentItemRepository, CreateWorkspaceOrganizationInput, EncryptedCredential, MediaAsset, MediaRepository, MonitorFingerprint, MonitorRepository, MonitorRule, MonitorRun, NotificationRepository, OAuthConnectionState, OAuthRepository, OrganizationRepository, OutboxMessage, OutboxMessageInput, OutboxRepository, OutboxStats, PostAnalyticsSnapshot, ProviderDataDeletionRequest, ProviderGrant, ProviderGrantChange, ProviderLifecycleRepository, ProviderPublishOperation, ProviderPublishOperationRepository, Workspace, WorkspaceNotification } from "./types.js";

interface InMemoryOutboxWriter {
  append(messages: OutboxMessageInput[]): void;
}

export class InMemoryContentItemRepository implements ContentItemRepository {
  private readonly items = new Map<string, ContentItem>();
  private readonly events: AuditEvent[] = [];

  constructor(private readonly outbox?: InMemoryOutboxWriter, private readonly providerOperations?: ProviderPublishOperationRepository, private readonly monitors?: MonitorRepository, private readonly automation?: AutomationRepository) {}

  async list(workspaceId: string, brandId?: string): Promise<ContentItem[]> {
    return [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId && (!brandId || item.brandId === brandId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(workspaceId: string, id: string): Promise<ContentItem | null> {
    const item = this.items.get(id);
    return item?.workspaceId === workspaceId ? structuredClone(item) : null;
  }

  async commit(item: ContentItem, event: AuditEvent, outbox: OutboxMessageInput[] = [], providerOperations: ProviderPublishOperation[] = [], monitorFingerprints: MonitorFingerprint[] = [], scheduleConflict?: ScheduleConflictCommit): Promise<void> {
    if (item.workspaceId !== event.workspaceId || item.id !== event.contentItemId) {
      throw new Error("Item and audit event must belong to the same workspace and content item.");
    }
    const existing = this.items.get(item.id);
    if ((!existing && item.version !== 1) || (existing && (existing.workspaceId !== item.workspaceId || item.version !== existing.version + 1))) {
      throw new DomainError("This content changed while you were working. Refresh it and try again.", "content_version_conflict", 409);
    }
    if (scheduleConflict) {
      const preflight = inspectScheduleConflicts([...this.items.values()], scheduleConflict.request);
      assertScheduleConflictAcknowledgement(preflight, scheduleConflict.acknowledgementSha256);
    }
    this.items.set(item.id, structuredClone(item));
    const committedEvent = structuredClone({ ...event, detail: { ...event.detail, contentVersion: item.version } });
    this.events.push(committedEvent);
    await this.automation?.recordEventFromAudit(committedEvent, item.brandId);
    this.outbox?.append(outbox);
    for (const operation of providerOperations) await this.providerOperations?.save(operation);
    await this.monitors?.recordFingerprints(monitorFingerprints);
  }

  async listAudit(workspaceId: string, contentItemId: string): Promise<AuditEvent[]> {
    return this.events
      .filter((event) => event.workspaceId === workspaceId && event.contentItemId === contentItemId)
      .map((event) => structuredClone(event));
  }
}

export class InMemoryOrganizationRepository implements OrganizationRepository {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly brands = new Map<string, Brand>();
  private readonly ownerMemberships = new Map<string, Set<string>>();

  constructor(private readonly registerMembership?: (membership: WorkspaceMembership) => void) {
    const createdAt = new Date().toISOString();
    this.workspaces.set("default", { id: "default", name: "My workspace", slug: "my-workspace", createdAt, updatedAt: createdAt });
    this.brands.set("brand_default", { id: "brand_default", workspaceId: "default", name: "Main brand", slug: "main", primaryLanguage: "English", timezone: "UTC", status: "active", createdBy: "local-owner", createdAt, updatedAt: createdAt });
  }

  async listWorkspaces(userId?: string): Promise<Workspace[]> {
    const allowed = userId ? this.ownerMemberships.get(userId) : undefined;
    return [...this.workspaces.values()].filter((workspace) => !userId || allowed?.has(workspace.id) || workspace.id === "default")
      .sort((a, b) => a.name.localeCompare(b.name)).map((workspace) => structuredClone(workspace));
  }

  async getWorkspace(id: string): Promise<Workspace | null> { const value = this.workspaces.get(id); return value ? structuredClone(value) : null }

  async createWorkspace(input: CreateWorkspaceOrganizationInput): Promise<{ workspace: Workspace; defaultBrand: Brand }> {
    if ([...this.workspaces.values()].some((workspace) => workspace.slug === input.workspace.slug)) throw new DomainError("This workspace slug is already used.", "workspace_slug_exists", 409);
    this.workspaces.set(input.workspace.id, structuredClone(input.workspace));
    this.brands.set(input.defaultBrand.id, structuredClone(input.defaultBrand));
    const allowed = this.ownerMemberships.get(input.ownerUserId) ?? new Set<string>();
    allowed.add(input.workspace.id); this.ownerMemberships.set(input.ownerUserId, allowed);
    this.registerMembership?.({ workspaceId: input.workspace.id, workspaceName: input.workspace.name, workspaceSlug: input.workspace.slug, userId: input.ownerUserId, role: "owner", createdAt: input.workspace.createdAt, updatedAt: input.workspace.updatedAt });
    return { workspace: structuredClone(input.workspace), defaultBrand: structuredClone(input.defaultBrand) };
  }

  async updateWorkspace(workspace: Workspace): Promise<Workspace> {
    if (!this.workspaces.has(workspace.id)) throw new DomainError("Workspace not found.", "workspace_not_found", 404);
    if ([...this.workspaces.values()].some((entry) => entry.id !== workspace.id && entry.slug === workspace.slug)) throw new DomainError("This workspace slug is already used.", "workspace_slug_exists", 409);
    this.workspaces.set(workspace.id, structuredClone(workspace)); return structuredClone(workspace);
  }

  async listBrands(workspaceId: string, includeArchived = false): Promise<Brand[]> {
    return [...this.brands.values()].filter((brand) => brand.workspaceId === workspaceId && (includeArchived || brand.status === "active"))
      .sort((a, b) => a.name.localeCompare(b.name)).map((brand) => structuredClone(brand));
  }

  async getBrand(workspaceId: string, id: string): Promise<Brand | null> { const value = this.brands.get(id); return value?.workspaceId === workspaceId ? structuredClone(value) : null }

  async saveBrand(brand: Brand): Promise<Brand> {
    if (!this.workspaces.has(brand.workspaceId)) throw new DomainError("Workspace not found.", "workspace_not_found", 404);
    if ([...this.brands.values()].some((entry) => entry.workspaceId === brand.workspaceId && entry.id !== brand.id && entry.slug === brand.slug)) throw new DomainError("This brand slug is already used in the workspace.", "brand_slug_exists", 409);
    this.brands.set(brand.id, structuredClone(brand)); return structuredClone(brand);
  }
}

export class InMemoryOutboxRepository implements OutboxRepository, InMemoryOutboxWriter {
  private readonly messages = new Map<string, OutboxMessage>();

  append(messages: OutboxMessageInput[]): void {
    for (const message of messages) {
      const duplicate = [...this.messages.values()].some((entry) => entry.workspaceId === message.workspaceId && entry.dedupeKey === message.dedupeKey);
      if (!duplicate) this.messages.set(message.id, { ...structuredClone(message), status: "pending", attempts: 0 });
    }
  }

  async claimAvailable(owner: string, limit = 25, leaseSeconds = 60): Promise<OutboxMessage[]> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    const available = [...this.messages.values()].filter((message) => new Date(message.availableAt) <= now && (message.status === "pending" || (message.status === "processing" && message.leaseExpiresAt && new Date(message.leaseExpiresAt) < now))).slice(0, limit);
    for (const message of available) this.messages.set(message.id, { ...message, status: "processing", attempts: message.attempts + 1, leaseOwner: owner, leaseExpiresAt });
    return available.map((message) => structuredClone(this.messages.get(message.id)!));
  }

  async complete(workspaceId: string, id: string): Promise<void> {
    const message = this.messages.get(id);
    if (message?.workspaceId === workspaceId) this.messages.set(id, { ...message, status: "processed", processedAt: new Date().toISOString(), leaseOwner: undefined, leaseExpiresAt: undefined });
  }

  async fail(workspaceId: string, id: string, error: string, retryAt: string, maxAttempts = 10): Promise<void> {
    const message = this.messages.get(id);
    if (message?.workspaceId === workspaceId) this.messages.set(id, { ...message, status: message.attempts >= maxAttempts ? "failed" : "pending", availableAt: retryAt, lastError: error.slice(0, 500), leaseOwner: undefined, leaseExpiresAt: undefined });
  }

  async recoverPublishTargets(): Promise<number> { return 0 }
  async recoverRemoteCorrections(): Promise<number> { return 0 }
  async recoverAgentBoardPlugins(): Promise<number> { return 0 }
  async recoverCredentialRefreshes(): Promise<number> { return 0 }
  async recoverProviderGrantValidations(): Promise<number> { return 0 }
  async recoverProviderDataDeletions(): Promise<number> { return 0 }

  async stats(workspaceId?: string): Promise<OutboxStats> {
    const messages = [...this.messages.values()].filter((message) => !workspaceId || message.workspaceId === workspaceId);
    const count = (status: OutboxMessage["status"]) => messages.filter((message) => message.status === status).length;
    const oldest = messages.filter((message) => message.status === "pending").sort((a, b) => a.availableAt.localeCompare(b.availableAt))[0]?.availableAt;
    return { pending: count("pending"), processing: count("processing"), processed: count("processed"), failed: count("failed"), ...(oldest ? { oldestPendingAt: oldest } : {}) };
  }

  async list(workspaceId: string, status?: OutboxMessage["status"], limit = 50): Promise<OutboxMessage[]> {
    return [...this.messages.values()].filter((message) => message.workspaceId === workspaceId && (!status || message.status === status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((message) => structuredClone(message));
  }

  async retry(workspaceId: string, id: string): Promise<boolean> {
    const message = this.messages.get(id);
    if (!message || message.workspaceId !== workspaceId || message.status !== "failed") return false;
    this.messages.set(id, { ...message, status: "pending", attempts: 0, availableAt: new Date().toISOString(), lastError: undefined, leaseOwner: undefined, leaseExpiresAt: undefined });
    return true;
  }
}

export class InMemoryMediaRepository implements MediaRepository {
  private readonly assets = new Map<string, MediaAsset>();
  constructor(private readonly contentItems?: ContentItemRepository, private readonly creativeStudio?: CreativeStudioRepository) {}

  async list(workspaceId: string, limit = 100, brandId?: string): Promise<MediaAsset[]> {
    return [...this.assets.values()].filter((asset) => asset.workspaceId === workspaceId && (!brandId || asset.brandId === brandId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((asset) => structuredClone(asset));
  }

  async get(workspaceId: string, id: string): Promise<MediaAsset | null> {
    const asset = this.assets.get(id);
    return asset?.workspaceId === workspaceId ? structuredClone(asset) : null;
  }

  async save(asset: MediaAsset): Promise<void> {
    const existing = this.assets.get(asset.id);
    if ((!existing && asset.version !== 1) || (existing && (existing.workspaceId !== asset.workspaceId || asset.version !== existing.version + 1))) {
      throw new DomainError("This media record changed while you were working. Refresh it and try again.", "media_version_conflict", 409);
    }
    this.assets.set(asset.id, structuredClone(asset));
  }

  async references(workspaceId: string, id: string) {
    const asset = this.assets.get(id);
    if (!asset || asset.workspaceId !== workspaceId) return { contentItemIds: [], draftIds: [], proofIds: [], creativeProjectIds: [], creativeRenderIds: [] };
    const items = await this.contentItems?.list(workspaceId) ?? [];
    const targetUsesCover=(target:ContentItem["targets"][number])=>{const cover=target.platform==="instagram"?(target.settings as InstagramPublishSettings|undefined)?.reelCover:undefined;return cover?.mode==="custom_image"&&cover.mediaId===id;};
    const matching = items.filter((item) => item.drafts.some((draft) => draft.mediaIds.includes(id))||item.targets.some(targetUsesCover)||item.proofs.some((proof)=>proof.instagramReelCoverProof?.mode==="custom_image"&&proof.instagramReelCoverProof.mediaId===id));
    const draftIds = matching.flatMap((item) => [...item.drafts.filter((draft) => draft.mediaIds.includes(id)).map((draft) => draft.id),...item.targets.filter(targetUsesCover).map((target)=>target.draftId)]);
    const proofIds = matching.flatMap((item) => item.proofs.filter((proof) => draftIds.includes(proof.draftId)||proof.instagramReelCoverProof?.mode==="custom_image"&&proof.instagramReelCoverProof.mediaId===id).map((proof) => proof.id));
    const creativeProjects = await this.creativeStudio?.listProjects(workspaceId, asset.brandId, 200) ?? [];
    const creativeRenderIds: string[] = [];
    const creativeProjectIds = new Set<string>();
    for (const project of creativeProjects) {
      if (project.outputMediaId === id) creativeProjectIds.add(project.id);
      for (const render of await this.creativeStudio?.listRenders(workspaceId, project.id, 200) ?? []) if (render.outputMediaId === id) { creativeProjectIds.add(project.id); creativeRenderIds.push(render.id); }
    }
    return { contentItemIds: matching.map((item) => item.id), draftIds: [...new Set(draftIds)], proofIds: [...new Set(proofIds)], creativeProjectIds: [...creativeProjectIds], creativeRenderIds: [...new Set(creativeRenderIds)] };
  }

  async summary(workspaceId: string, brandId?: string) {
    const assets = [...this.assets.values()].filter((asset) => asset.workspaceId === workspaceId && (!brandId || asset.brandId === brandId));
    const counts: Record<string, number> = {};
    for (const asset of assets) counts[asset.status] = (counts[asset.status] ?? 0) + 1;
    const stored = assets.filter((asset) => !["rejected", "expired", "deleted"].includes(asset.status));
    return {
      totalAssets: assets.length,
      storedBytes: stored.reduce((total, asset) => total + asset.sizeBytes, 0),
      reclaimableBytes: assets.filter((asset) => asset.status === "trashed" || asset.status === "cleanup_failed").reduce((total, asset) => total + asset.sizeBytes, 0),
      pendingBytes: assets.filter((asset) => asset.status === "pending").reduce((total, asset) => total + asset.sizeBytes, 0),
      counts,
    };
  }

  async listCleanupCandidates(now: string, limit = 100, workspaceId?: string): Promise<MediaAsset[]> {
    const at = new Date(now);
    return [...this.assets.values()].filter((asset) =>
      (!workspaceId || asset.workspaceId === workspaceId) && (
        (asset.status === "pending" && new Date(asset.uploadExpiresAt) <= at)
        || (asset.status === "trashed" && Boolean(asset.trashExpiresAt) && new Date(asset.trashExpiresAt!) <= at)
        || (asset.status === "cleanup_failed" && Boolean(asset.cleanupAfter) && new Date(asset.cleanupAfter!) <= at)
      )
    ).slice(0, limit).map((asset) => structuredClone(asset));
  }
}

export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly notifications = new Map<string, WorkspaceNotification>();

  async list(workspaceId: string, options: { unreadOnly?: boolean; limit?: number; includeOperatorAlerts?: boolean } = {}): Promise<WorkspaceNotification[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
    return [...this.notifications.values()]
      .filter((entry) => entry.workspaceId === workspaceId && (options.includeOperatorAlerts || entry.audience !== "operators") && (!options.unreadOnly || !entry.readAt))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((entry) => structuredClone(entry));
  }

  async countUnread(workspaceId: string, options: { includeOperatorAlerts?: boolean } = {}): Promise<number> {
    return [...this.notifications.values()].filter((entry) => entry.workspaceId === workspaceId && (options.includeOperatorAlerts || entry.audience !== "operators") && !entry.readAt).length;
  }

  async create(notification: WorkspaceNotification): Promise<WorkspaceNotification> {
    const existing = [...this.notifications.values()].find((entry) => entry.workspaceId === notification.workspaceId && entry.dedupeKey === notification.dedupeKey);
    if (existing) return structuredClone(existing);
    this.notifications.set(notification.id, structuredClone(notification));
    return structuredClone(notification);
  }

  async markRead(workspaceId: string, id: string, actorId: string, readAt: string, options: { includeOperatorAlerts?: boolean } = {}): Promise<WorkspaceNotification | null> {
    const current = this.notifications.get(id);
    if (!current || current.workspaceId !== workspaceId || (current.audience === "operators" && !options.includeOperatorAlerts)) return null;
    const next = current.readAt ? current : { ...current, readAt, readBy: actorId };
    this.notifications.set(id, next);
    return structuredClone(next);
  }

  async markAllRead(workspaceId: string, actorId: string, readAt: string, options: { includeOperatorAlerts?: boolean } = {}): Promise<number> {
    let count = 0;
    for (const [id, current] of this.notifications) {
      if (current.workspaceId !== workspaceId || current.readAt || (current.audience === "operators" && !options.includeOperatorAlerts)) continue;
      this.notifications.set(id, { ...current, readAt, readBy: actorId });
      count += 1;
    }
    return count;
  }
}

export class InMemoryAnalyticsRepository implements AnalyticsRepository {
  private readonly snapshots = new Map<string, PostAnalyticsSnapshot>();

  async list(workspaceId: string, options: { brandId?: string; proofId?: string; limit?: number } = {}): Promise<PostAnalyticsSnapshot[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 2000));
    return [...this.snapshots.values()]
      .filter((entry) => entry.workspaceId === workspaceId && (!options.brandId || entry.brandId === options.brandId) && (!options.proofId || entry.proofId === options.proofId))
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
      .slice(0, limit)
      .map((entry) => structuredClone(entry));
  }

  async latestForProof(workspaceId: string, proofId: string): Promise<PostAnalyticsSnapshot | null> {
    return (await this.list(workspaceId, { proofId, limit: 1 }))[0] ?? null;
  }

  async save(snapshot: PostAnalyticsSnapshot, event: AuditEvent): Promise<void> {
    if (snapshot.workspaceId !== event.workspaceId || snapshot.contentItemId !== event.contentItemId) throw new Error("Analytics and audit event must belong to the same content item.");
    this.snapshots.set(snapshot.id, structuredClone(snapshot));
  }
}

export class InMemoryAnalyticsReportRepository implements AnalyticsReportRepository {
  private readonly definitions = new Map<string, AnalyticsReportDefinition>();
  private readonly snapshots = new Map<string, AnalyticsReportSnapshot>();
  private readonly shares = new Map<string, AnalyticsReportShare>();

  async listDefinitions(workspaceId: string, includeArchived = false): Promise<AnalyticsReportDefinition[]> {
    return [...this.definitions.values()]
      .filter((definition) => definition.workspaceId === workspaceId && (includeArchived || definition.status === "active"))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((definition) => structuredClone(definition));
  }

  async getDefinition(workspaceId: string, reportId: string): Promise<AnalyticsReportDefinition | null> {
    const definition = this.definitions.get(reportId);
    return definition?.workspaceId === workspaceId ? structuredClone(definition) : null;
  }

  async saveDefinition(definition: AnalyticsReportDefinition, event: AuditEvent): Promise<void> {
    if (definition.workspaceId !== event.workspaceId || event.detail.reportId !== definition.id) throw new Error("Analytics report and audit event must have matching lineage.");
    const existing = this.definitions.get(definition.id);
    if ((!existing && definition.version !== 1) || (existing && (existing.workspaceId !== definition.workspaceId || definition.version !== existing.version + 1))) {
      throw new DomainError("This report changed while you were working.", "analytics_report_version_conflict", 409);
    }
    this.definitions.set(definition.id, structuredClone(definition));
  }

  async listSnapshots(workspaceId: string, reportId: string, limit = 20): Promise<AnalyticsReportSnapshot[]> {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.workspaceId === workspaceId && snapshot.reportId === reportId)
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((snapshot) => structuredClone(snapshot));
  }

  async getSnapshot(workspaceId: string, reportId: string, snapshotId: string): Promise<AnalyticsReportSnapshot | null> {
    const snapshot = this.snapshots.get(snapshotId);
    return snapshot?.workspaceId === workspaceId && snapshot.reportId === reportId ? structuredClone(snapshot) : null;
  }

  async saveSnapshot(snapshot: AnalyticsReportSnapshot, event: AuditEvent): Promise<void> {
    if (snapshot.workspaceId !== event.workspaceId || event.detail.reportId !== snapshot.reportId || event.detail.snapshotId !== snapshot.id) throw new Error("Analytics snapshot and audit event must have matching lineage.");
    if (!this.definitions.has(snapshot.reportId)) throw new DomainError("Analytics report not found.", "analytics_report_not_found", 404);
    if (!this.snapshots.has(snapshot.id)) this.snapshots.set(snapshot.id, structuredClone(snapshot));
  }

  async saveShare(share: AnalyticsReportShare, event: AuditEvent): Promise<void> {
    if (share.workspaceId !== event.workspaceId || event.detail.reportId !== share.reportId || event.detail.shareId !== share.id) throw new Error("Analytics report share and audit event must have matching lineage.");
    const snapshot = this.snapshots.get(share.snapshotId);
    if (!snapshot || snapshot.workspaceId !== share.workspaceId || snapshot.reportId !== share.reportId) throw new DomainError("Analytics report snapshot not found.", "analytics_report_snapshot_not_found", 404);
    if ([...this.shares.values()].some((entry) => entry.tokenSha256 === share.tokenSha256)) throw new DomainError("Analytics report share token already exists.", "analytics_report_share_exists", 409);
    this.shares.set(share.id, structuredClone(share));
  }

  async listShares(workspaceId: string, reportId: string, snapshotId?: string): Promise<AnalyticsReportShare[]> {
    return [...this.shares.values()]
      .filter((share) => share.workspaceId === workspaceId && share.reportId === reportId && (!snapshotId || share.snapshotId === snapshotId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((share) => structuredClone(share));
  }

  async getShareByTokenSha256(tokenSha256: string): Promise<AnalyticsReportShare | null> {
    const share = [...this.shares.values()].find((entry) => entry.tokenSha256 === tokenSha256);
    return share ? structuredClone(share) : null;
  }

  async revokeShare(workspaceId: string, reportId: string, shareId: string, actorId: string, revokedAt: string, event: AuditEvent): Promise<AnalyticsReportShare | null> {
    const share = this.shares.get(shareId);
    if (!share || share.workspaceId !== workspaceId || share.reportId !== reportId) return null;
    const next = { ...share, revokedAt, revokedBy: actorId };
    this.shares.set(shareId, next);
    return structuredClone(next);
  }
}

export class InMemoryEngagementRepository implements EngagementRepository {
  private readonly threads = new Map<string, EngagementThread>();
  private readonly comments = new Map<string, EngagementComment>();
  private readonly actions = new Map<string, EngagementAction>();
  private readonly reads = new Map<string, ReadMarker>();
  private readonly receipts = new Map<string, EngagementWebhookReceipt>();

  async listThreads(scope: BrandScope, query: InboxQuery): Promise<InboxPage> {
    const normalizedQuery = query.query?.normalize("NFC").trim().toLocaleLowerCase();
    const all = [...this.threads.values()]
      .filter((thread) => thread.workspaceId === scope.workspaceId && thread.brandId === scope.brandId)
      .filter((thread) => !query.state || thread.state === query.state)
      .filter((thread) => !query.assignedTo || thread.assignedTo === query.assignedTo)
      .filter((thread) => !query.accountId || thread.accountId === query.accountId)
      .filter((thread) => {
        if (!normalizedQuery) return true;
        return this.commentsForThread(thread.id).some((comment) => `${comment.authorUsername ?? ""}\n${comment.body}`.toLocaleLowerCase().includes(normalizedQuery));
      })
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id));
    const cursorIndex = query.cursor ? all.findIndex((thread) => thread.id === query.cursor) : -1;
    const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    const limit = Math.max(1, Math.min(query.limit ?? 30, 100));
    const selected = all.slice(start, start + limit);
    const items = selected.map((thread) => {
      const comments = this.commentsForThread(thread.id);
      const latestComment = comments.at(-1);
      const marker = this.reads.get(this.readKey(scope, thread.id, query.viewerId));
      const unreadCount = comments.filter((comment) => comment.direction === "incoming" && (!marker || comment.lastSeenAt > marker.lastReadAt)).length;
      const latestIncoming = [...comments].reverse().find((comment) => comment.direction === "incoming");
      const latestOutgoing = [...comments].reverse().find((comment) => comment.direction === "outgoing");
      return {
        thread: structuredClone(thread),
        ...(latestComment ? { latestComment: structuredClone(latestComment) } : {}),
        unreadCount,
        needsReply: Boolean(latestIncoming && (!latestOutgoing || this.commentTime(latestIncoming) > this.commentTime(latestOutgoing))),
      };
    });
    const nextCursor = start + selected.length < all.length ? selected.at(-1)?.id : undefined;
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }

  async getThread(scope: BrandScope, id: string): Promise<EngagementThreadView | null> {
    const thread = this.threads.get(id);
    if (!thread || thread.workspaceId !== scope.workspaceId || thread.brandId !== scope.brandId) return null;
    return {
      thread: structuredClone(thread),
      comments: this.commentsForThread(id).map((comment) => structuredClone(comment)),
      actions: [...this.actions.values()].filter((action) => action.workspaceId === scope.workspaceId && action.brandId === scope.brandId && action.threadId === id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((action) => structuredClone(action)),
    };
  }

  async getComment(scope: BrandScope, id: string): Promise<EngagementComment | null> {
    const comment = this.comments.get(id);
    return comment?.workspaceId === scope.workspaceId && comment.brandId === scope.brandId ? structuredClone(comment) : null;
  }

  async getAction(scope: BrandScope, id: string): Promise<EngagementAction | null> {
    const action = this.actions.get(id);
    return action?.workspaceId === scope.workspaceId && action.brandId === scope.brandId ? structuredClone(action) : null;
  }

  async updateThread(scope: BrandScope, id: string, command: EngagementThreadUpdate, event: AuditEvent): Promise<EngagementThread | null> {
    if (event.workspaceId !== scope.workspaceId) throw new Error("Engagement thread update and audit event must belong to the same workspace.");
    const current = this.threads.get(id);
    if (!current || current.workspaceId !== scope.workspaceId || current.brandId !== scope.brandId) return null;
    if (current.version !== command.expectedVersion) throw new DomainError("This thread changed while you were working. Refresh it and try again.", "engagement_thread_version_conflict", 409);
    const nextState = command.state ?? current.state;
    const next: EngagementThread = {
      ...current,
      state: nextState,
      ...(command.assignedTo !== undefined ? { assignedTo: command.assignedTo ?? undefined } : {}),
      resolvedAt: nextState === "resolved" ? (current.resolvedAt ?? command.at) : undefined,
      version: current.version + 1,
    };
    this.threads.set(id, structuredClone(next));
    return structuredClone(next);
  }

  async ingest(scope: BrandScope, batch: CommentIngestBatch, event: AuditEvent): Promise<IngestResult> {
    if (event.workspaceId !== scope.workspaceId || batch.thread.workspaceId !== scope.workspaceId || batch.thread.brandId !== scope.brandId) {
      throw new Error("Engagement ingest scope does not match its thread and audit event.");
    }
    const existing = [...this.threads.values()].find((thread) => thread.workspaceId === scope.workspaceId && thread.brandId === scope.brandId && thread.proofId === batch.thread.proofId);
    if (existing && existing.id !== batch.thread.id) throw new DomainError("This proof already has an engagement thread.", "engagement_thread_exists", 409);
    let inserted = 0;
    let updated = 0;
    let hasNewIncoming = false;
    for (const incoming of batch.comments) {
      if (incoming.workspaceId !== scope.workspaceId || incoming.brandId !== scope.brandId || incoming.threadId !== batch.thread.id || incoming.accountId !== batch.thread.accountId || incoming.externalMediaId !== batch.thread.externalMediaId) {
        throw new Error("Engagement comment lineage does not match its ingest thread.");
      }
      const current = [...this.comments.values()].find((comment) => comment.accountId === incoming.accountId && comment.externalCommentId === incoming.externalCommentId);
      if (current) {
        if (current.workspaceId !== scope.workspaceId || current.brandId !== scope.brandId || current.threadId !== batch.thread.id) throw new DomainError("A provider comment is already linked to another thread.", "engagement_comment_conflict", 409);
        this.comments.set(current.id, structuredClone({ ...incoming, id: current.id, firstSeenAt: current.firstSeenAt }));
        updated += 1;
      } else {
        this.comments.set(incoming.id, structuredClone(incoming));
        inserted += 1;
        if (incoming.direction === "incoming") hasNewIncoming = true;
      }
    }
    const reopened = Boolean(existing?.state === "resolved" && hasNewIncoming);
    const activityAt = batch.comments.reduce((latest, comment) => this.commentTime(comment) > latest ? this.commentTime(comment) : latest, existing?.lastActivityAt ?? batch.thread.lastActivityAt);
    const thread: EngagementThread = existing
      ? { ...existing, state: reopened ? "open" : existing.state, resolvedAt: reopened ? undefined : existing.resolvedAt, lastActivityAt: activityAt, lastSyncedAt: batch.syncedAt, version: existing.version + 1 }
      : { ...structuredClone(batch.thread), lastActivityAt: activityAt, lastSyncedAt: batch.syncedAt };
    this.threads.set(thread.id, thread);
    return { thread: structuredClone(thread), inserted, updated, reopened };
  }

  async markRead(scope: BrandScope, threadId: string, userId: string, marker: ReadMarker): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread || thread.workspaceId !== scope.workspaceId || thread.brandId !== scope.brandId) throw new DomainError("Engagement thread not found.", "engagement_thread_not_found", 404);
    if (marker.lastReadCommentId && !this.commentsForThread(threadId).some((comment) => comment.id === marker.lastReadCommentId)) throw new DomainError("The read marker comment is not in this thread.", "engagement_read_marker_invalid", 400);
    this.reads.set(this.readKey(scope, threadId, userId), structuredClone(marker));
  }

  async saveAction(action: EngagementAction, event: AuditEvent): Promise<void> {
    if (action.workspaceId !== event.workspaceId) throw new Error("Engagement action and audit event must belong to the same workspace.");
    const thread = this.threads.get(action.threadId);
    const comment = this.comments.get(action.commentId);
    if (!thread || !comment || thread.workspaceId !== action.workspaceId || thread.brandId !== action.brandId || comment.threadId !== thread.id || comment.direction !== "incoming") throw new DomainError("Reply action lineage is invalid.", "engagement_action_lineage_invalid", 400);
    const existing = this.actions.get(action.id);
    if ((!existing && action.version !== 1) || (existing && (existing.workspaceId !== action.workspaceId || existing.brandId !== action.brandId || action.version !== existing.version + 1))) {
      throw new DomainError("This reply changed while you were working. Refresh it and try again.", "engagement_action_version_conflict", 409);
    }
    const duplicate = [...this.actions.values()].find((entry) => entry.workspaceId === action.workspaceId && entry.idempotencyKey === action.idempotencyKey && entry.id !== action.id);
    if (duplicate) throw new DomainError("This exact reply action already exists.", "engagement_action_duplicate", 409);
    this.actions.set(action.id, structuredClone(action));
  }

  async transitionAction(scope: BrandScope, command: ActionTransition, event: AuditEvent): Promise<EngagementAction | null> {
    if (event.workspaceId !== scope.workspaceId) throw new Error("Engagement transition and audit event must belong to the same workspace.");
    const current = this.actions.get(command.actionId);
    if (!current || current.workspaceId !== scope.workspaceId || current.brandId !== scope.brandId) return null;
    const next = transitionEngagementAction(current, command);
    this.actions.set(next.id, structuredClone(next));
    return structuredClone(next);
  }

  async listActionsForRecovery(statuses: EngagementActionStatus[] = ["queued", "processing", "uncertain"], limit = 100): Promise<EngagementAction[]> {
    return [...this.actions.values()].filter((action) => statuses.includes(action.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, Math.max(1, Math.min(limit, 500))).map((action) => structuredClone(action));
  }

  async listThreadsNeedingSync(before: string, limit = 100): Promise<EngagementThread[]> {
    return [...this.threads.values()].filter((thread) => thread.state === "open" && (!thread.lastSyncedAt || thread.lastSyncedAt < before))
      .sort((a, b) => (a.lastSyncedAt ?? "").localeCompare(b.lastSyncedAt ?? "")).slice(0, Math.max(1, Math.min(limit, 500))).map((thread) => structuredClone(thread));
  }

  async recordWebhookReceipt(receipt: EngagementWebhookReceipt): Promise<{ receipt: EngagementWebhookReceipt; created: boolean }> {
    const existing = [...this.receipts.values()].find((entry) => entry.provider === receipt.provider && entry.payloadSha256 === receipt.payloadSha256);
    if (existing) return { receipt: structuredClone(existing), created: false };
    this.receipts.set(receipt.id, structuredClone(receipt));
    return { receipt: structuredClone(receipt), created: true };
  }

  async claimWebhookReceipts(owner: string, limit = 25, leaseSeconds = 60): Promise<EngagementWebhookReceipt[]> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseSeconds * 1_000).toISOString();
    const available = [...this.receipts.values()].filter((receipt) => new Date(receipt.availableAt) <= now && (receipt.status === "pending" || (receipt.status === "processing" && receipt.leaseExpiresAt && new Date(receipt.leaseExpiresAt) < now)))
      .sort((a, b) => a.availableAt.localeCompare(b.availableAt)).slice(0, Math.max(1, Math.min(limit, 100)));
    return available.map((receipt) => {
      const claimed: EngagementWebhookReceipt = { ...receipt, status: "processing", attempts: receipt.attempts + 1, leaseOwner: owner, leaseExpiresAt: expiresAt };
      this.receipts.set(receipt.id, claimed);
      return structuredClone(claimed);
    });
  }

  async completeWebhookReceipt(id: string, leaseOwner: string, processedAt: string): Promise<void> {
    const current = this.receipts.get(id);
    if (current?.status === "processing" && current.leaseOwner === leaseOwner) this.receipts.set(id, { ...current, status: "processed", processedAt, leaseOwner: undefined, leaseExpiresAt: undefined });
  }

  async failWebhookReceipt(id: string, leaseOwner: string, error: string, retryAt: string, maxAttempts = 10): Promise<void> {
    const current = this.receipts.get(id);
    if (current?.status === "processing" && current.leaseOwner === leaseOwner) this.receipts.set(id, { ...current, status: current.attempts >= maxAttempts ? "failed" : "pending", availableAt: retryAt, lastError: error.slice(0, 500), leaseOwner: undefined, leaseExpiresAt: undefined });
  }

  private commentsForThread(threadId: string): EngagementComment[] {
    return [...this.comments.values()].filter((comment) => comment.threadId === threadId)
      .sort((a, b) => this.commentTime(a).localeCompare(this.commentTime(b)) || a.id.localeCompare(b.id));
  }

  private commentTime(comment: EngagementComment): string { return comment.providerCreatedAt ?? comment.firstSeenAt }
  private readKey(scope: BrandScope, threadId: string, userId: string): string { return `${scope.workspaceId}:${scope.brandId}:${threadId}:${userId}` }
}

export class InMemoryConnectedAccountRepository implements ConnectedAccountRepository, ProviderLifecycleRepository {
  private readonly accounts = new Map<string, ConnectedAccount>();
  private readonly providerGrants = new Map<string, ProviderGrant>();
  private readonly providerGrantLinks = new Map<string, { id: string; grantId: string; workspaceId: string; accountId: string; linkedAt: string; unlinkedAt?: string }>();
  private readonly providerLifecycleReceipts = new Map<string, { eventType: "deauthorization" | "data_deletion"; clientId: string; payloadSha256: string; matchedGrants: number; affectedAccounts: number; deletionRequestId?: string }>();
  private readonly providerDeletionRequests = new Map<string, ProviderDataDeletionRequest>();
  private readonly providerDeletionScopes = new Map<string, { status: ProviderDataDeletionRequest["status"]; grantIds: string[]; accountIds: string[] }>();
  private readonly events: AuditEvent[] = [];
  constructor(private readonly oauthRepository?: OAuthRepository, private readonly notificationRepository?: NotificationRepository) {}

  async list(workspaceId: string, brandId?: string): Promise<ConnectedAccount[]> {
    return [...this.accounts.values()].filter((account) => account.workspaceId === workspaceId && (!brandId || account.brandId === brandId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((account) => structuredClone(account));
  }

  async get(workspaceId: string, id: string): Promise<ConnectedAccount | null> {
    const account = this.accounts.get(id);
    return account?.workspaceId === workspaceId ? structuredClone(account) : null;
  }

  async listProviderGrants(workspaceId: string, brandId?: string): Promise<Array<{ grant: ProviderGrant; accountIds: string[] }>> {
    return [...this.providerGrants.values()].filter((grant) => grant.workspaceId === workspaceId).flatMap((grant) => {
      const accountIds = [...this.providerGrantLinks.values()]
        .filter((link) => link.workspaceId === workspaceId && link.grantId === grant.id && !link.unlinkedAt)
        .map((link) => link.accountId)
        .filter((accountId) => !brandId || this.accounts.get(accountId)?.brandId === brandId);
      return accountIds.length ? [{ grant: structuredClone(grant), accountIds }] : [];
    }).sort((a, b) => b.grant.updatedAt.localeCompare(a.grant.updatedAt));
  }

  async recordProviderGrantValidation(input: { workspaceId: string; grantId: string; expectedVersion: number; outcome: "healthy" | "transient_failure" | "review_required" | "reauthorization_required"; checkedAt: string; nextValidationAt?: string; errorCode?: string; errorSummary?: string }): Promise<boolean> {
    const grant = this.providerGrants.get(input.grantId);
    if (!grant || grant.workspaceId !== input.workspaceId || grant.version !== input.expectedVersion || !["active", "expiring", "refresh_failed"].includes(grant.status)) return false;
    const status = input.outcome === "healthy" ? "active" : input.outcome === "reauthorization_required" ? "reauthorization_required" : "refresh_failed";
    this.providerGrants.set(grant.id, { ...grant, status, version: grant.version + 1, lastCheckedAt: input.checkedAt, ...(input.outcome === "healthy" ? { lastHealthyAt: input.checkedAt, lastErrorCode: undefined, lastErrorSummary: undefined } : { lastErrorCode: input.errorCode, lastErrorSummary: input.errorSummary }), ...(input.nextValidationAt ? { nextValidationAt: input.nextValidationAt } : { nextValidationAt: undefined }), ...(input.outcome === "reauthorization_required" ? { nextRefreshAt: undefined } : {}), updatedAt: input.checkedAt });
    if (input.outcome === "reauthorization_required") {
      const accounts = this.linkedAccounts([grant]);
      for (const account of accounts) {
        const credentialId = account.credentialRef?.startsWith("secret:") ? account.credentialRef.slice(7) : undefined;
        if (credentialId) await this.oauthRepository?.deleteCredential(account.workspaceId, credentialId);
        this.accounts.set(account.id, { ...account, credentialRef: undefined, capabilities: [], status: "disconnected", expiresAt: undefined, lastHealthyAt: undefined, lastCheckedAt: input.checkedAt, lastErrorCode: input.errorCode ?? "provider_validation_rejected", lastErrorStep: "Reconnect provider access", lastErrorSummary: input.errorSummary ?? "The provider no longer confirms this authorization. Reconnect to restore access.", updatedAt: input.checkedAt });
      }
      await this.notificationRepository?.create({ id: `notification_${crypto.randomUUID()}`, workspaceId: input.workspaceId, kind: "connection_attention", severity: "warning", title: "Provider access needs reconnection", body: "Provider validation failed permanently. Publishing was blocked for every linked account.", actionUrl: `/?module=channels&grant=${encodeURIComponent(grant.id)}`, dedupeKey: `provider-validation:${grant.id}:${grant.version}:blocked`, createdAt: input.checkedAt });
    } else if (input.outcome === "review_required") {
      await this.notificationRepository?.create({ id: `notification_${crypto.randomUUID()}`, workspaceId: input.workspaceId, kind: "connection_attention", severity: "warning", title: "Provider access needs review", body: input.errorSummary ?? "OriginPost could not verify every account linked to this authorization. Review it in Channels.", actionUrl: `/?module=channels&grant=${encodeURIComponent(grant.id)}`, dedupeKey: `provider-validation:${grant.id}:${grant.version}:review`, createdAt: input.checkedAt });
    }
    this.events.push({ id: `audit_${crypto.randomUUID()}`, workspaceId: input.workspaceId, actorId: "originpost-provider-validator", actorType: "system", action: `provider-grant.validation-${input.outcome.replaceAll("_", "-")}`, detail: { providerGrantId: grant.id, provider: grant.provider, expectedVersion: input.expectedVersion, outcome: input.outcome }, createdAt: input.checkedAt });
    return true;
  }

  async save(account: ConnectedAccount, event: AuditEvent, credentialChange?: { save?: EncryptedCredential; deleteId?: string }, providerGrantChange?: ProviderGrantChange): Promise<void> {
    if (account.workspaceId !== event.workspaceId) throw new Error("Account and audit event must belong to the same workspace.");
    if (credentialChange?.save && credentialChange.save.workspaceId !== account.workspaceId) throw new Error("Account and credential must belong to the same workspace.");
    if (providerGrantChange && Boolean(providerGrantChange.grant) === Boolean(providerGrantChange.unlink)) throw new Error("A provider grant change must link one grant or unlink the account.");
    if (providerGrantChange?.grant && providerGrantChange.grant.workspaceId !== account.workspaceId) throw new Error("Account and provider grant must belong to the same workspace.");
    this.accounts.set(account.id, structuredClone(account));
    if (providerGrantChange?.grant) {
      const grant = providerGrantChange.grant;
      const currentGrant = this.providerGrants.get(grant.id);
      this.providerGrants.set(grant.id, structuredClone({
        ...grant,
        scopes: [...new Set([...(currentGrant?.scopes ?? []), ...grant.scopes])].sort(),
        version: currentGrant ? currentGrant.version + 1 : grant.version,
      }));
      this.linkProviderGrant(account, grant.id);
    } else if (providerGrantChange?.unlink) {
      const displaced = new Set<string>();
      for (const [id, link] of this.providerGrantLinks) if (link.workspaceId === account.workspaceId && link.accountId === account.id && !link.unlinkedAt) { this.providerGrantLinks.set(id, { ...link, unlinkedAt: account.updatedAt }); displaced.add(link.grantId); }
      for (const grantId of displaced) this.supersedeUnlinkedGrant(grantId, account.updatedAt);
    }
    this.events.push(structuredClone(event));
    if (credentialChange?.save) await this.oauthRepository?.saveCredential(credentialChange.save);
    if (credentialChange?.deleteId && credentialChange.deleteId !== credentialChange.save?.id) await this.oauthRepository?.deleteCredential(account.workspaceId, credentialChange.deleteId);
  }

  private linkProviderGrant(account: ConnectedAccount, grantId: string): void {
    const displaced = new Set<string>();
    for (const [id, link] of this.providerGrantLinks) if (link.workspaceId === account.workspaceId && link.accountId === account.id && !link.unlinkedAt && link.grantId !== grantId) { this.providerGrantLinks.set(id, { ...link, unlinkedAt: account.updatedAt }); displaced.add(link.grantId); }
    const linkId = `grant_link_${crypto.randomUUID()}`;
    if (![...this.providerGrantLinks.values()].some((link) => link.workspaceId === account.workspaceId && link.accountId === account.id && link.grantId === grantId && !link.unlinkedAt)) this.providerGrantLinks.set(linkId, { id: linkId, grantId, workspaceId: account.workspaceId, accountId: account.id, linkedAt: account.updatedAt });
    for (const displacedGrantId of displaced) this.supersedeUnlinkedGrant(displacedGrantId, account.updatedAt);
  }

  private supersedeUnlinkedGrant(grantId: string, at: string): void {
    const grant = this.providerGrants.get(grantId);
    if (!grant || !["active", "expiring", "refresh_failed", "reauthorization_required"].includes(grant.status)) return;
    const hasCurrentLink = [...this.providerGrantLinks.values()].some((link) => link.grantId === grantId && !link.unlinkedAt);
    this.providerGrants.set(grantId, hasCurrentLink
      ? { ...grant, version: grant.version + 1, updatedAt: at }
      : { ...grant, status: "superseded", version: grant.version + 1, nextRefreshAt: undefined, nextValidationAt: undefined, updatedAt: at });
  }

  async saveCredentialRefreshResult(account: ConnectedAccount, event: AuditEvent, fence: { expectedCredentialRef: string; expectedExpiresAt: string }, credentialChange?: { save?: EncryptedCredential; deleteId?: string }, notification?: WorkspaceNotification): Promise<boolean> {
    const current = this.accounts.get(account.id);
    if (!current || current.workspaceId !== account.workspaceId || current.credentialRef !== fence.expectedCredentialRef || current.expiresAt !== fence.expectedExpiresAt || current.status === "disconnected" || current.status === "setup_required") return false;
    const lifecycleResult: ConnectedAccount = {
      ...current,
      credentialRef: account.credentialRef,
      status: account.status,
      expiresAt: account.expiresAt,
      lastCheckedAt: account.lastCheckedAt,
      lastHealthyAt: account.lastHealthyAt,
      lastErrorCode: account.lastErrorCode,
      lastErrorStep: account.lastErrorStep,
      lastErrorSummary: account.lastErrorSummary,
      updatedAt: account.updatedAt,
    };
    await this.save(lifecycleResult, event, credentialChange);
    const currentLink = [...this.providerGrantLinks.values()].find((link) => link.workspaceId === account.workspaceId && link.accountId === account.id && !link.unlinkedAt);
    const grant = currentLink ? this.providerGrants.get(currentLink.grantId) : undefined;
    if (grant && !["deauthorized", "revoked", "deletion_pending", "deleted", "superseded"].includes(grant.status)) {
      const status = lifecycleResult.status === "healthy" ? "active" : lifecycleResult.status === "expiring" ? "expiring" : lifecycleResult.status === "refresh_failed" ? "refresh_failed" : "reauthorization_required";
      const nextRefreshAt = lifecycleResult.expiresAt && (status === "active" || status === "expiring") ? new Date(Math.max(Date.parse(lifecycleResult.updatedAt), Date.parse(lifecycleResult.expiresAt) - (lifecycleResult.platform === "instagram" ? 7 * 24 * 60 * 60_000 : 15 * 60_000))).toISOString() : undefined;
      this.providerGrants.set(grant.id, { ...grant, status, accessExpiresAt: lifecycleResult.expiresAt, nextRefreshAt, lastCheckedAt: lifecycleResult.lastCheckedAt, lastHealthyAt: lifecycleResult.lastHealthyAt, lastErrorCode: lifecycleResult.lastErrorCode, lastErrorSummary: lifecycleResult.lastErrorSummary, version: grant.version + 1, updatedAt: lifecycleResult.updatedAt });
    }
    if (notification) await this.notificationRepository?.create(notification);
    return true;
  }

  async completeOAuthSelection(workspaceId: string, selectionCredentialId: string, entries: Array<{ account: ConnectedAccount; event: AuditEvent; credentialChange: { save: EncryptedCredential; deleteId?: string } }>, providerGrantChange?: ProviderGrantChange): Promise<boolean> {
    if (!this.oauthRepository) throw new Error("OAuth credential storage is unavailable.");
    for (const { account, event, credentialChange } of entries) {
      if (account.workspaceId !== workspaceId || event.workspaceId !== workspaceId || credentialChange.save.workspaceId !== workspaceId) throw new Error("OAuth selection completion must stay in one workspace.");
    }
    const selection = await this.oauthRepository.consumeCredential(workspaceId, selectionCredentialId, "provider-discovery");
    if (!selection) return false;
    const previousAccounts = new Map(entries.map(({ account }) => [account.id, this.accounts.get(account.id)]));
    const previousGrants = new Map(this.providerGrants);
    const previousLinks = new Map(this.providerGrantLinks);
    const previousCredentials = new Map<string, EncryptedCredential | null>();
    for (const { credentialChange } of entries) {
      previousCredentials.set(credentialChange.save.id, await this.oauthRepository.getCredential(workspaceId, credentialChange.save.id));
      if (credentialChange.deleteId) previousCredentials.set(credentialChange.deleteId, await this.oauthRepository.getCredential(workspaceId, credentialChange.deleteId));
    }
    const eventLength = this.events.length;
    try {
      if (providerGrantChange) {
        if (!providerGrantChange.grant || providerGrantChange.unlink || providerGrantChange.grant.workspaceId !== workspaceId) throw new Error("OAuth grant completion must link one grant in the same workspace.");
        const grant = providerGrantChange.grant;
        const currentGrant = this.providerGrants.get(grant.id);
        this.providerGrants.set(grant.id, structuredClone({
          ...grant,
          scopes: [...new Set([...(currentGrant?.scopes ?? []), ...grant.scopes])].sort(),
          version: currentGrant ? currentGrant.version + 1 : grant.version,
        }));
      }
      for (const { account, event, credentialChange } of entries) {
        await this.save(account, event, credentialChange);
        if (providerGrantChange?.grant) this.linkProviderGrant(account, providerGrantChange.grant.id);
      }
      return true;
    } catch (error) {
      for (const [id, previous] of previousAccounts) previous ? this.accounts.set(id, previous) : this.accounts.delete(id);
      this.providerGrants.clear(); for (const [id, previous] of previousGrants) this.providerGrants.set(id, previous);
      this.providerGrantLinks.clear(); for (const [id, previous] of previousLinks) this.providerGrantLinks.set(id, previous);
      this.events.length = eventLength;
      for (const [id, previous] of previousCredentials) previous ? await this.oauthRepository.saveCredential(previous) : await this.oauthRepository.deleteCredential(workspaceId, id);
      await this.oauthRepository.saveCredential(selection);
      throw error;
    }
  }

  private matchingMetaGrants(clientId: string, lookupCandidates: Array<{ version: string; digest: string }>, includeDeleted = false): ProviderGrant[] {
    return [...this.providerGrants.values()].filter((grant) => grant.provider === "meta" && grant.clientId === clientId && lookupCandidates.some((candidate) => grant.lookupKeyVersion === candidate.version && grant.subjectLookupHmac === candidate.digest) && (includeDeleted || grant.status !== "deleted") && grant.status !== "superseded");
  }

  private linkedAccounts(grants: ProviderGrant[]): ConnectedAccount[] {
    const ids = new Set(grants.map((grant) => grant.id));
    const accountIds = new Set([...this.providerGrantLinks.values()].filter((link) => ids.has(link.grantId) && !link.unlinkedAt).map((link) => link.accountId));
    return [...accountIds].map((id) => this.accounts.get(id)).filter((account): account is ConnectedAccount => Boolean(account));
  }

  private async blockMetaAccess(grants: ProviderGrant[], accounts: ConnectedAccount[], status: "deauthorized" | "deletion_pending", at: string): Promise<void> {
    for (const grant of grants) this.providerGrants.set(grant.id, { ...grant, status, version: grant.version + 1, nextRefreshAt: undefined, nextValidationAt: undefined, lastCheckedAt: at, lastErrorCode: status === "deauthorized" ? "provider_deauthorized" : "provider_data_deletion", lastErrorSummary: status === "deauthorized" ? "The provider removed this authorization. Reconnect to restore access." : "Provider-derived data deletion is in progress.", updatedAt: at });
    for (const account of accounts) {
      const id = account.credentialRef?.startsWith("secret:") ? account.credentialRef.slice(7) : undefined;
      if (id) await this.oauthRepository?.deleteCredential(account.workspaceId, id);
      this.accounts.set(account.id, { ...account, credentialRef: undefined, capabilities: [], status: "disconnected", expiresAt: undefined, lastHealthyAt: undefined, lastCheckedAt: at, lastErrorCode: status === "deauthorized" ? "provider_deauthorized" : "provider_data_deletion", lastErrorStep: status === "deauthorized" ? "Reconnect provider access" : "Provider data deletion", lastErrorSummary: status === "deauthorized" ? "The provider removed this authorization. Reconnect to restore access." : "Provider-derived data deletion is in progress.", updatedAt: at });
    }
  }

  async receiveMetaDeauthorization(input: { id: string; clientId: string; lookupKeyVersion: string; subjectLookupHmac: string; lookupCandidates: Array<{ version: string; digest: string }>; payloadSha256: string; receivedAt: string }): Promise<{ created: boolean; matchedGrants: number; affectedAccounts: number }> {
    const key = `deauthorization:${input.clientId}:${input.payloadSha256}`;
    const existing = this.providerLifecycleReceipts.get(key);
    if (existing) return { created: false, matchedGrants: existing.matchedGrants, affectedAccounts: existing.affectedAccounts };
    const grants = this.matchingMetaGrants(input.clientId, input.lookupCandidates);
    const accounts = this.linkedAccounts(grants);
    await this.blockMetaAccess(grants, accounts, "deauthorized", input.receivedAt);
    this.providerLifecycleReceipts.set(key, { eventType: "deauthorization", clientId: input.clientId, payloadSha256: input.payloadSha256, matchedGrants: grants.length, affectedAccounts: accounts.length });
    return { created: true, matchedGrants: grants.length, affectedAccounts: accounts.length };
  }

  async receiveMetaDataDeletion(input: { receiptId: string; requestId: string; clientId: string; lookupKeyVersion: string; subjectLookupHmac: string; lookupCandidates: Array<{ version: string; digest: string }>; payloadSha256: string; confirmationNonce: string; confirmationCodeSha256: string; receivedAt: string }): Promise<{ created: boolean; matchedGrants: number; affectedAccounts: number; request: ProviderDataDeletionRequest }> {
    const receiptKey = `data_deletion:${input.clientId}:${input.payloadSha256}`;
    const priorReceipt = this.providerLifecycleReceipts.get(receiptKey);
    if (priorReceipt?.deletionRequestId) return { created: false, matchedGrants: priorReceipt.matchedGrants, affectedAccounts: priorReceipt.affectedAccounts, request: structuredClone(this.providerDeletionRequests.get(priorReceipt.deletionRequestId)!) };
    const grants = this.matchingMetaGrants(input.clientId, input.lookupCandidates, true);
    const accounts = this.linkedAccounts(grants);
    const generation = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(grants.length ? grants.map((grant) => `${grant.id}:${grant.issuedAt}`).join("|") : `no-data:${input.clientId}:${input.lookupKeyVersion}:${input.subjectLookupHmac}`)).then((value) => Buffer.from(value).toString("hex"));
    const existingRequest = [...this.providerDeletionRequests.values()].find((request) => request.clientId === input.clientId && input.lookupCandidates.some((candidate) => request.lookupKeyVersion === candidate.version && request.subjectLookupHmac === candidate.digest) && request.grantGenerationSha256 === generation);
    const workspaces = [...new Set(grants.map((grant) => grant.workspaceId))];
    const request: ProviderDataDeletionRequest = existingRequest ?? { id: input.requestId, provider: "meta", clientId: input.clientId, lookupKeyVersion: input.lookupKeyVersion, subjectLookupHmac: input.subjectLookupHmac, grantGenerationSha256: generation, confirmationNonce: input.confirmationNonce, confirmationCodeSha256: input.confirmationCodeSha256, status: workspaces.length ? "pending" : "completed", scopeCount: workspaces.length, completedScopeCount: 0, publicSummary: workspaces.length ? "OriginPost is removing provider-derived data. Workspace-authored drafts and media are retained." : "No matching OriginPost provider authorization or provider-derived data was found.", requestedAt: input.receivedAt, ...(workspaces.length ? {} : { completedAt: input.receivedAt }), updatedAt: input.receivedAt };
    if (!existingRequest) {
      this.providerDeletionRequests.set(request.id, structuredClone(request));
      for (const workspaceId of workspaces) {
        const workspaceGrants = grants.filter((grant) => grant.workspaceId === workspaceId);
        const workspaceAccounts = accounts.filter((account) => account.workspaceId === workspaceId);
        this.providerDeletionScopes.set(`${request.id}:${workspaceId}`, { status: "pending", grantIds: workspaceGrants.map((grant) => grant.id), accountIds: workspaceAccounts.map((account) => account.id) });
      }
      await this.blockMetaAccess(grants, accounts, "deletion_pending", input.receivedAt);
    }
    this.providerLifecycleReceipts.set(receiptKey, { eventType: "data_deletion", clientId: input.clientId, payloadSha256: input.payloadSha256, matchedGrants: grants.length, affectedAccounts: accounts.length, deletionRequestId: request.id });
    return { created: !existingRequest, matchedGrants: grants.length, affectedAccounts: accounts.length, request: structuredClone(request) };
  }

  async getDataDeletionByConfirmationSha256(confirmationCodeSha256: string): Promise<ProviderDataDeletionRequest | null> {
    const request = [...this.providerDeletionRequests.values()].find((entry) => entry.confirmationCodeSha256 === confirmationCodeSha256);
    return request ? structuredClone(request) : null;
  }

  async getDataDeletionScope(requestId: string, workspaceId: string): Promise<{ status: ProviderDataDeletionRequest["status"]; accountIds: string[]; hasPrivateData: boolean } | null> {
    const scope = this.providerDeletionScopes.get(`${requestId}:${workspaceId}`);
    return scope ? { status: scope.status, accountIds: [...scope.accountIds], hasPrivateData: false } : null;
  }

  async processDataDeletionScope(requestId: string, workspaceId: string, processedAt: string): Promise<boolean> {
    const key = `${requestId}:${workspaceId}`;
    const scope = this.providerDeletionScopes.get(key);
    if (!scope || scope.status === "completed") return false;
    for (const accountId of scope.accountIds) {
      const account = this.accounts.get(accountId);
      if (account) this.accounts.set(accountId, { ...account, displayName: "Deleted provider account", externalAccountId: `deleted:${account.id}`, credentialRef: undefined, capabilities: [], status: "disconnected", expiresAt: undefined, lastHealthyAt: undefined, lastErrorCode: "provider_data_deleted", lastErrorStep: "Reconnect provider access", lastErrorSummary: "Provider-derived account data was removed from OriginPost.", updatedAt: processedAt });
    }
    for (const grantId of scope.grantIds) { const grant = this.providerGrants.get(grantId); if (grant) this.providerGrants.set(grantId, { ...grant, status: "deleted", scopes: [], version: grant.version + 1, updatedAt: processedAt }); }
    this.providerDeletionScopes.set(key, { ...scope, status: "completed" });
    const request = this.providerDeletionRequests.get(requestId)!;
    const completed = [...this.providerDeletionScopes.entries()].filter(([id, value]) => id.startsWith(`${requestId}:`) && value.status === "completed").length;
    this.providerDeletionRequests.set(requestId, { ...request, status: completed === request.scopeCount ? "completed" : "processing", completedScopeCount: completed, ...(completed === request.scopeCount ? { completedAt: processedAt, publicSummary: "OriginPost removed the provider-derived data covered by this request. Workspace-authored drafts and media were retained." } : {}), updatedAt: processedAt });
    await this.notificationRepository?.create({ id: `notification_${crypto.randomUUID()}`, workspaceId, kind: "connection_attention", severity: "info", title: "Provider data deletion completed", body: "OriginPost removed the provider-derived data covered by this workspace scope. Workspace-authored drafts and media were retained.", actionUrl: "/?module=channels", dedupeKey: `provider-deletion:${requestId}:${workspaceId}:completed`, createdAt: processedAt });
    return true;
  }

  async failDataDeletionScope(requestId: string, workspaceId: string, errorCode: string, failedAt: string): Promise<void> {
    const safeCode = errorCode.replace(/[^a-z0-9_-]/gi, "_").slice(0, 80) || "provider_data_deletion_failed";
    const key = `${requestId}:${workspaceId}`; const scope = this.providerDeletionScopes.get(key); if (scope && scope.status !== "completed") {
      this.providerDeletionScopes.set(key, { ...scope, status: "needs_review" });
      for (const grantId of scope.grantIds) { const grant = this.providerGrants.get(grantId); if (grant) this.providerGrants.set(grantId, { ...grant, lastCheckedAt: failedAt, lastErrorCode: safeCode, lastErrorSummary: "OriginPost could not finish provider-data deletion automatically. The request is retained for operator review.", updatedAt: failedAt }); }
    }
    const request = this.providerDeletionRequests.get(requestId); if (request && request.status !== "completed") this.providerDeletionRequests.set(requestId, { ...request, status: "needs_review", publicSummary: "OriginPost could not finish this deletion automatically. The request is retained for operator review.", updatedAt: failedAt });
    await this.notificationRepository?.create({ id: `notification_${crypto.randomUUID()}`, workspaceId, kind: "connection_attention", severity: "warning", title: "Provider data deletion needs review", body: "OriginPost could not finish this deletion automatically. The request is retained for operator review.", actionUrl: "/?module=channels", dedupeKey: `provider-deletion:${requestId}:${workspaceId}:needs-review`, createdAt: failedAt });
  }
}

export class InMemoryOAuthRepository implements OAuthRepository {
  private readonly states = new Map<string, OAuthConnectionState>();
  private readonly credentials = new Map<string, EncryptedCredential>();

  async createState(state: OAuthConnectionState): Promise<void> {
    const discoveryCutoff = new Date(new Date(state.createdAt).getTime() - 60 * 60_000).toISOString();
    for (const [id, credential] of this.credentials) {
      if (credential.purpose === "provider-discovery" && credential.createdAt < discoveryCutoff) this.credentials.delete(id);
    }
    for (const [id, current] of this.states) {
      if (current.expiresAt < state.createdAt || (current.consumedAt && current.consumedAt < new Date(new Date(state.createdAt).getTime() - 86_400_000).toISOString())) this.states.delete(id);
    }
    this.states.set(state.id, structuredClone(state));
  }

  async consumeState(stateHash: string, platform: OAuthConnectionState["platform"], now: string): Promise<OAuthConnectionState | null> {
    const current = [...this.states.values()].find((state) => state.stateHash === stateHash && state.platform === platform && !state.consumedAt && state.expiresAt > now);
    if (!current) return null;
    const consumed = { ...current, consumedAt: now };
    this.states.set(current.id, consumed);
    return structuredClone(consumed);
  }

  async saveCredential(credential: EncryptedCredential): Promise<void> { this.credentials.set(credential.id, structuredClone(credential)); }
  async getCredential(workspaceId: string, id: string): Promise<EncryptedCredential | null> {
    const credential = this.credentials.get(id);
    return credential?.workspaceId === workspaceId ? structuredClone(credential) : null;
  }
  async hasCredential(workspaceId: string, id: string): Promise<boolean> { return Boolean(await this.getCredential(workspaceId, id)); }
  async consumeCredential(workspaceId: string, id: string, purpose: EncryptedCredential["purpose"]): Promise<EncryptedCredential | null> {
    const credential = this.credentials.get(id);
    if (!credential || credential.workspaceId !== workspaceId || credential.purpose !== purpose) return null;
    this.credentials.delete(id);
    return structuredClone(credential);
  }
  async deleteCredential(workspaceId: string, id: string): Promise<void> {
    if (this.credentials.get(id)?.workspaceId === workspaceId) this.credentials.delete(id);
  }
}

export class InMemoryProviderPublishOperationRepository implements ProviderPublishOperationRepository {
  private readonly operations = new Map<string, ProviderPublishOperation>();
  constructor(private readonly clock: () => Date = () => new Date()) {}
  async get(workspaceId: string, targetId: string): Promise<ProviderPublishOperation | null> {
    const value = this.operations.get(targetId);
    return value?.workspaceId === workspaceId ? structuredClone(value) : null;
  }
  async listByStatus(workspaceId: string, statuses: ProviderPublishOperation["status"][]): Promise<ProviderPublishOperation[]> {
    const wanted = new Set(statuses);
    return [...this.operations.values()].filter((value) => value.workspaceId === workspaceId && wanted.has(value.status)).map((value) => structuredClone(value));
  }
  async save(operation: ProviderPublishOperation): Promise<void> { this.operations.set(operation.targetId, structuredClone(operation)); }
  async claimExecution(operation: ProviderPublishOperation, owner: string, leaseSeconds = 900): Promise<{ claimed: boolean; created: boolean; operation: ProviderPublishOperation }> {
    const current = this.operations.get(operation.targetId);
    const now = this.clock();
    if (!current) {
      const claimed = { ...operation, claimOwner: owner, claimExpiresAt: new Date(now.getTime() + leaseSeconds * 1000).toISOString() };
      this.operations.set(operation.targetId, structuredClone(claimed));
      return { claimed: true, created: true, operation: structuredClone(claimed) };
    }
    const available = current.workspaceId === operation.workspaceId
      && (!current.claimOwner || !current.claimExpiresAt || Date.parse(current.claimExpiresAt) <= now.getTime());
    if (!available) return { claimed: false, created: false, operation: structuredClone(current) };
    const claimed = { ...current, claimOwner: owner, claimExpiresAt: new Date(now.getTime() + leaseSeconds * 1000).toISOString() };
    this.operations.set(operation.targetId, structuredClone(claimed));
    return { claimed: true, created: false, operation: structuredClone(claimed) };
  }
  async saveClaimed(operation: ProviderPublishOperation, owner: string, leaseSeconds = 900): Promise<boolean> {
    const current = this.operations.get(operation.targetId);
    const now = this.clock();
    if (!current || current.workspaceId !== operation.workspaceId || current.claimOwner !== owner || !current.claimExpiresAt || Date.parse(current.claimExpiresAt) <= now.getTime()) return false;
    this.operations.set(operation.targetId, structuredClone({ ...operation, claimOwner: owner, claimExpiresAt: new Date(now.getTime() + leaseSeconds * 1000).toISOString() }));
    return true;
  }
}

export class InMemoryMonitorRepository implements MonitorRepository {
  private readonly rules = new Map<string, MonitorRule>();
  private readonly runs = new Map<string, MonitorRun>();
  private readonly fingerprints = new Set<string>();

  async list(workspaceId: string, brandId?: string): Promise<MonitorRule[]> {
    return [...this.rules.values()].filter((rule) => rule.workspaceId === workspaceId && (!brandId || rule.brandId === brandId)).map((rule) => structuredClone(rule));
  }

  async listEnabled(): Promise<MonitorRule[]> {
    return [...this.rules.values()].filter((rule) => rule.enabled).map((rule) => structuredClone(rule));
  }

  async get(workspaceId: string, id: string): Promise<MonitorRule | null> {
    const rule = this.rules.get(id);
    return rule?.workspaceId === workspaceId ? structuredClone(rule) : null;
  }

  async save(rule: MonitorRule): Promise<void> {
    this.rules.set(rule.id, structuredClone(rule));
  }

  async startRun(run: MonitorRun): Promise<boolean> {
    const active = [...this.runs.values()].some((entry) => entry.workspaceId === run.workspaceId && entry.monitorId === run.monitorId && entry.status === "running");
    if (active) return false;
    this.runs.set(run.id, structuredClone(run));
    return true;
  }

  async recordSkipped(run: MonitorRun): Promise<void> {
    if (run.status !== "skipped") throw new Error("Only skipped monitor runs can be recorded through this method.");
    this.runs.set(run.id, structuredClone(run));
  }

  async finishRun(run: MonitorRun, fingerprints: MonitorFingerprint[]): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
    await this.recordFingerprints(fingerprints);
  }

  async recordFingerprints(fingerprints: MonitorFingerprint[]): Promise<void> {
    for (const fingerprint of fingerprints) this.fingerprints.add(`${fingerprint.workspaceId}:${fingerprint.monitorId}:${fingerprint.fingerprint}`);
  }

  async listRuns(workspaceId: string, monitorId: string, limit = 20): Promise<MonitorRun[]> {
    return [...this.runs.values()].filter((run) => run.workspaceId === workspaceId && run.monitorId === monitorId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit).map((run) => structuredClone(run));
  }

  async hasFingerprint(workspaceId: string, monitorId: string, fingerprint: string): Promise<boolean> {
    return this.fingerprints.has(`${workspaceId}:${monitorId}:${fingerprint}`);
  }
}
