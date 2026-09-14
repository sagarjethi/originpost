import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { can, DomainError, sourceSnapshotKey, signalToContentItem, type Actor, type SourceSignal } from "@originpost/domain";
import crypto from "node:crypto";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { SourceSignalQueryDto } from "./dto/source-signal.dto.js";

@Injectable()
export class SourceSignalsService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure) {}

  async list(workspaceId: string, query: SourceSignalQueryDto, actor: Actor) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view source signals.");
    return this.infrastructure.sourceSignalRepository.list({ workspaceId, ...(query.brandId ? { brandId: query.brandId } : {}), ...(query.state ? { state: query.state } : {}), ...(query.monitorId ? { monitorId: query.monitorId } : {}), ...(query.search ? { search: query.search } : {}), offset: query.offset, sort: query.sort, ...(query.recentHours ? { publishedAfter: new Date(Date.now() - query.recentHours * 3600000).toISOString(), publishedBefore: new Date().toISOString() } : {}), limit: query.limit });
  }

  async summary(workspaceId: string, brandId: string | undefined, actor: Actor) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view source signal totals.");
    return this.infrastructure.sourceSignalRepository.summary(workspaceId, brandId);
  }

  private async require(workspaceId: string, id: string): Promise<SourceSignal> {
    const signal = await this.infrastructure.sourceSignalRepository.get(workspaceId, id);
    if (!signal) throw new DomainError("Source signal not found.", "source_signal_not_found", 404);
    return signal;
  }

  private expected(value: number | undefined): number { if (!value) throw new DomainError("Use If-Match with the current signal version.", "version_required", 428); return value; }

  async get(workspaceId: string, id: string, actor: Actor) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view this source signal.");
    return this.require(workspaceId, id);
  }

  async screenshot(workspaceId: string, id: string, sourceId: string, actor: Actor) {
    const signal = await this.get(workspaceId, id, actor);
    const source = signal.sources.find(source => source.id === sourceId);
    if (!source?.snapshot) throw new DomainError("Source screenshot not found.", "source_snapshot_not_found", 404);
    return { ...await this.infrastructure.mediaObjectStore.createDownload(sourceSnapshotKey(workspaceId, signal.brandId, source.snapshot.sha256), "publisher-desktop.png"),
      snapshot: source.snapshot, rights: "reference-only" };
  }

  async save(workspaceId: string, id: string, expectedVersion: number | undefined, actor: Actor) {
    const signal = await this.require(workspaceId, id);
    if (signal.state === "saved" && signal.contentItemId) { const existing = await this.infrastructure.repository.get(workspaceId, signal.contentItemId); if (existing) return { signal, contentItem: existing, idempotentReplay: true }; }
    if (signal.state === "dismissed") throw new DomainError("Restore this signal before saving it.", "source_signal_dismissed", 409);
    const requestedVersion = this.expected(expectedVersion);
    if (requestedVersion !== signal.version) throw new DomainError("This signal changed in another tab.", "version_conflict", 409);
    const created = signalToContentItem(signal, actor);
    let item = await this.infrastructure.repository.get(workspaceId, created.item.id);
    let replay = Boolean(item);
    const validItem = () => {
      if (item && (item.brandId !== signal.brandId || !item.tags.includes("signal"))) throw new DomainError("A conflicting Content Item already uses this signal identity.", "source_signal_content_conflict", 409);
    };
    validItem();

    let claimed: SourceSignal | null = null;
    if (signal.state === "saving") {
      if (signal.pendingContentItemId !== created.item.id || !signal.saveClaimId) throw new DomainError("This signal has an invalid save reservation.", "source_signal_recovery_required", 409);
      if (item) {
        const recovered = await this.infrastructure.sourceSignalRepository.finishSave({ workspaceId, id, expectedVersion: signal.version, actorId: actor.id, at: new Date().toISOString(), claimId: signal.saveClaimId, contentItemId: item.id });
        if (recovered) return { signal: recovered, contentItem: item, idempotentReplay: true };
      }
      if (Date.parse(signal.saveLeaseExpiresAt ?? "") > Date.now()) throw new DomainError("This signal is already being saved. Refresh in a moment.", "source_signal_save_in_progress", 409);
    }

    const at = new Date();
    claimed = await this.infrastructure.sourceSignalRepository.claimSave({ workspaceId, id, expectedVersion: signal.version, actorId: actor.id, at: at.toISOString(), claimId: `signal-save-${crypto.randomUUID()}`, leaseExpiresAt: new Date(at.getTime() + 120_000).toISOString(), contentItemId: created.item.id });
    if (!claimed) throw new DomainError("This signal changed in another tab.", "version_conflict", 409);
    if (!item) { await this.infrastructure.repository.commit(created.item, created.event); item = created.item; }
    validItem();
    const saved = await this.infrastructure.sourceSignalRepository.finishSave({ workspaceId, id, expectedVersion: claimed.version, actorId: actor.id, at: new Date().toISOString(), claimId: claimed.saveClaimId!, contentItemId: item.id });
    if (!saved) { const current = await this.require(workspaceId, id); if (current.state === "saved" && current.contentItemId === item.id) { replay = true; return { signal: current, contentItem: item, idempotentReplay: replay }; } throw new DomainError("The Content Item is safe, but the signal still needs save recovery. Refresh and try again.", "source_signal_recovery_required", 409); }
    return { signal: saved, contentItem: item, idempotentReplay: replay };
  }

  async dismiss(workspaceId: string, id: string, expectedVersion: number | undefined, reason: string | undefined, actor: Actor) {
    if ((actor.actorType && actor.actorType !== "human") || !can(actor.role, "content:edit")) throw new ForbiddenException("Only an editor can dismiss source signals.");
    const current = await this.require(workspaceId, id); if (current.state === "saved") throw new DomainError("A saved signal stays linked to its Content Item.", "source_signal_already_saved", 409);
    const result = await this.infrastructure.sourceSignalRepository.triage({ workspaceId, id, expectedVersion: this.expected(expectedVersion), actorId: actor.id, at: new Date().toISOString(), action: "dismissed", ...(reason?.trim() ? { reason } : {}) });
    if (!result) throw new DomainError("This signal changed in another tab.", "version_conflict", 409); return result;
  }

  async restore(workspaceId: string, id: string, expectedVersion: number | undefined, actor: Actor) {
    if ((actor.actorType && actor.actorType !== "human") || !can(actor.role, "content:edit")) throw new ForbiddenException("Only an editor can restore source signals.");
    const current = await this.require(workspaceId, id); if (current.state !== "dismissed") throw new DomainError("Only dismissed signals can return to the desk.", "source_signal_not_dismissed", 409);
    const result = await this.infrastructure.sourceSignalRepository.triage({ workspaceId, id, expectedVersion: this.expected(expectedVersion), actorId: actor.id, at: new Date().toISOString(), action: "restored" });
    if (!result) throw new DomainError("This signal changed in another tab.", "version_conflict", 409); return result;
  }
}
