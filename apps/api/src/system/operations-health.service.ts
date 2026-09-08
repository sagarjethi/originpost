import { createHash } from "node:crypto";
import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { can, createNotification, type Actor, type OperationalCheckId, type OperationalIncidentStatus } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { MEDIA_MALWARE_SCANNER, type MediaMalwareScanner, type MediaMalwareScannerHealth } from "../media/media-malware-scanner.js";

export type OperationsCheckView = {
  id: OperationalCheckId;
  label: string;
  status: "healthy" | "warning" | "error" | "disabled";
  summary: string;
  detail: string;
  evidence: Record<string, number | string | boolean | null>;
};

export type OperationsHealthView = {
  workspaceId: string;
  status: "healthy" | "warning" | "error";
  checkedAt: string;
  checks: OperationsCheckView[];
};

type CheckWithFingerprint = OperationsCheckView & { fingerprintEvidence?: Record<string, unknown> };

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ageMinutes(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 60_000)) : null;
}

@Injectable()
export class OperationsHealthService {
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    @Inject(MEDIA_MALWARE_SCANNER) private readonly malwareScanner: MediaMalwareScanner,
    private readonly config: ConfigService,
  ) {}

  private authorize(actor: Actor): void {
    if (!can(actor.role, "automation:manage")) throw new ForbiddenException("You cannot view workspace operations.");
  }

  async view(workspaceId: string, actor: Actor): Promise<OperationsHealthView> {
    this.authorize(actor);
    return this.evaluate(workspaceId, await this.malwareScanner.inspect(), false);
  }

  async evaluateFleetAndAlert(): Promise<void> {
    const scannerHealth = await this.malwareScanner.inspect();
    const workspaces = await this.infrastructure.organizationRepository.listWorkspaces();
    await Promise.all(workspaces.map((workspace) => this.evaluate(workspace.id, scannerHealth, true)));
  }

  private async evaluate(workspaceId: string, scannerHealth: MediaMalwareScannerHealth, recordAlerts: boolean): Promise<OperationsHealthView> {
    const checkedAt = new Date().toISOString();
    const now = Date.parse(checkedAt);
    const stalePublishMinutes = Number(this.config.get<string>("OPERATIONS_PUBLISH_STALE_MINUTES") ?? 30);
    const staleOutboxMinutes = Number(this.config.get<string>("OPERATIONS_OUTBOX_STALE_MINUTES") ?? 15);
    const [deliverySummary, mediaSummary, uncertainPublishes, items, outbox] = await Promise.all([
      this.infrastructure.automationRepository.deliveryStatusSummary(workspaceId),
      this.infrastructure.mediaRepository.summary(workspaceId),
      this.infrastructure.providerPublishOperationRepository.listByStatus(workspaceId, ["uncertain"]),
      this.infrastructure.repository.list(workspaceId),
      this.infrastructure.outboxRepository.stats(workspaceId),
    ]);

    const deadLetters = deliverySummary.counts.dead_letter ?? 0;
    const cleanupFailures = mediaSummary.counts.cleanup_failed ?? 0;
    const attentionTargets = items.flatMap((item) => item.targets.filter((target) => target.status === "action_required" || target.status === "failed").map((target) => ({ id: target.id, status: target.status, updatedAt: item.updatedAt })));
    const stalledTargets = items.flatMap((item) => item.targets.filter((target) => target.status === "publishing" && ageMinutes(item.updatedAt, now)! >= stalePublishMinutes).map((target) => ({ id: target.id, updatedAt: item.updatedAt })));
    const oldestOutboxAgeMinutes = ageMinutes(outbox.oldestPendingAt, now);

    const malwareCheck: CheckWithFingerprint = scannerHealth.status === "disabled"
      ? { id: "malware_protection", label: "Malware protection", status: "disabled", summary: "Disabled while live publishing is off", detail: "Uploaded media is not malware-scanned in this environment. OriginPost configuration prevents live publishing unless ClamAV is enabled.", evidence: { scanner: scannerHealth.scanner } }
      : scannerHealth.status === "unavailable"
        ? { id: "malware_protection", label: "Malware protection", status: "error", summary: "ClamAV is unavailable", detail: "New uploads fail closed until the scanner responds again.", evidence: { errorCode: scannerHealth.errorCode }, fingerprintEvidence: { errorCode: scannerHealth.errorCode } }
        : scannerHealth.status === "stale"
          ? { id: "malware_protection", label: "Malware protection", status: "warning", summary: "ClamAV signatures are stale", detail: "Refresh the signature database before relying on new media scans.", evidence: { engineVersion: scannerHealth.engineVersion, signatureVersion: scannerHealth.signatureVersion, signatureUpdatedAt: scannerHealth.signatureUpdatedAt ?? null, signatureAgeHours: Math.round(scannerHealth.signatureAgeHours ?? 0) }, fingerprintEvidence: { signatureVersion: scannerHealth.signatureVersion, signatureUpdatedAt: scannerHealth.signatureUpdatedAt } }
          : { id: "malware_protection", label: "Malware protection", status: "healthy", summary: "ClamAV signatures are current", detail: "The scanner responded and its signature database is within the configured freshness window.", evidence: { engineVersion: scannerHealth.engineVersion, signatureVersion: scannerHealth.signatureVersion, signatureUpdatedAt: scannerHealth.signatureUpdatedAt ?? null, signatureAgeHours: Math.round(scannerHealth.signatureAgeHours ?? 0) } };

    const checks: CheckWithFingerprint[] = [
      malwareCheck,
      deadLetters
        ? { id: "webhook_delivery", label: "Webhook delivery", status: "error", summary: `${deadLetters} dead-letter delivery${deadLetters === 1 ? "" : "ies"}`, detail: "Review the failed webhook destination and explicitly retry the delivery from Developer API.", evidence: { deadLetters, latestDeadLetterAt: deliverySummary.latestDeadLetterAt ?? null }, fingerprintEvidence: { deadLetters, latestDeadLetterId: deliverySummary.latestDeadLetterId, latestDeadLetterAt: deliverySummary.latestDeadLetterAt } }
        : { id: "webhook_delivery", label: "Webhook delivery", status: "healthy", summary: "No dead-letter deliveries", detail: "No webhook delivery has exhausted its bounded retry policy.", evidence: { deadLetters: 0 } },
      cleanupFailures
        ? { id: "media_cleanup", label: "Media cleanup", status: "error", summary: `${cleanupFailures} cleanup failure${cleanupFailures === 1 ? "" : "s"}`, detail: "Stored media could not be removed after its retention window. The cleanup job will retry without hiding the failure.", evidence: { cleanupFailures, reclaimableBytes: mediaSummary.reclaimableBytes }, fingerprintEvidence: { cleanupFailures, reclaimableBytes: mediaSummary.reclaimableBytes } }
        : { id: "media_cleanup", label: "Media cleanup", status: "healthy", summary: "No cleanup failures", detail: "Expired and trashed media cleanup has no recorded failures.", evidence: { cleanupFailures: 0 } },
      uncertainPublishes.length || attentionTargets.length || stalledTargets.length
        ? { id: "publishing_attention", label: "Publishing attention", status: uncertainPublishes.length ? "error" : "warning", summary: `${uncertainPublishes.length + attentionTargets.length + stalledTargets.length} publishing item${uncertainPublishes.length + attentionTargets.length + stalledTargets.length === 1 ? "" : "s"} need review`, detail: uncertainPublishes.length ? "At least one provider outcome is uncertain. Reconcile with the provider before retrying so OriginPost cannot create a duplicate post." : "Review failed, manual-handoff, or stalled publishing work before continuing.", evidence: { uncertain: uncertainPublishes.length, actionRequiredOrFailed: attentionTargets.length, stalled: stalledTargets.length }, fingerprintEvidence: { uncertain: uncertainPublishes.map((entry) => [entry.id, entry.updatedAt]), attention: attentionTargets.map((entry) => [entry.id, entry.status, entry.updatedAt]), stalled: stalledTargets.map((entry) => [entry.id, entry.updatedAt]) } }
        : { id: "publishing_attention", label: "Publishing attention", status: "healthy", summary: "No uncertain or stalled publishes", detail: "Publishing records do not require operator reconciliation.", evidence: { uncertain: 0, actionRequiredOrFailed: 0, stalled: 0 } },
      outbox.failed || (oldestOutboxAgeMinutes !== null && oldestOutboxAgeMinutes >= staleOutboxMinutes)
        ? { id: "delivery_queue", label: "Delivery queue", status: outbox.failed ? "error" : "warning", summary: outbox.failed ? `${outbox.failed} failed command${outbox.failed === 1 ? "" : "s"}` : `Oldest command has waited ${oldestOutboxAgeMinutes} minutes`, detail: outbox.failed ? "Review and retry the failed durable command after correcting its underlying cause." : "A queued command has exceeded the expected processing window.", evidence: { failed: outbox.failed, pending: outbox.pending, processing: outbox.processing, oldestPendingAgeMinutes: oldestOutboxAgeMinutes }, fingerprintEvidence: { failed: outbox.failed, pending: outbox.pending, processing: outbox.processing, oldestPendingAt: outbox.oldestPendingAt } }
        : { id: "delivery_queue", label: "Delivery queue", status: "healthy", summary: "Durable commands are moving", detail: "The outbox has no failures or overdue pending command.", evidence: { failed: 0, pending: outbox.pending, processing: outbox.processing, oldestPendingAgeMinutes: oldestOutboxAgeMinutes } },
    ];

    if (recordAlerts) await Promise.all(checks.map((check) => this.recordCheck(workspaceId, checkedAt, check)));
    const status = checks.some((check) => check.status === "error") ? "error" : checks.some((check) => check.status === "warning") ? "warning" : "healthy";
    return { workspaceId, status, checkedAt, checks: checks.map(({ fingerprintEvidence: _fingerprintEvidence, ...check }) => check) };
  }

  private async recordCheck(workspaceId: string, checkedAt: string, check: CheckWithFingerprint): Promise<void> {
    const incidentStatus: OperationalIncidentStatus | undefined = check.status === "warning" || check.status === "error" ? check.status : undefined;
    const issueFingerprint = incidentStatus ? fingerprint({ status: incidentStatus, evidence: check.fingerprintEvidence ?? check.evidence }) : undefined;
    const observed = await this.infrastructure.operationalIncidentRepository.observe({ workspaceId, checkId: check.id, ...(incidentStatus ? { status: incidentStatus, fingerprint: issueFingerprint } : {}), observedAt: checkedAt });
    if ((observed.transition !== "opened" && observed.transition !== "changed") || !observed.incident) return;
    await this.infrastructure.notificationRepository.create(createNotification({
      workspaceId,
      kind: "system",
      severity: check.status === "error" ? "error" : "warning",
      title: check.summary,
      body: `${check.label}: ${check.detail}`,
      dedupeKey: `operations:${check.id}:${observed.incident.openedAt}:${observed.incident.fingerprint}`,
      actionUrl: "/?module=organizations#operations-health",
      audience: "operators",
      now: checkedAt,
    }));
  }
}
