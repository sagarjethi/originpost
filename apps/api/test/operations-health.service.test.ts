import { ConfigService } from "@nestjs/config";
import { createContentRepository } from "@originpost/db";
import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
import type { MediaMalwareScanner } from "../src/media/media-malware-scanner.js";
import { OperationsHealthService } from "../src/system/operations-health.service.js";

function disabledScanner(): MediaMalwareScanner {
  return {
    async scan() { return { status: "disabled", scannedAt: new Date().toISOString(), scanner: "test/disabled" } as const },
    async inspect() { return { status: "disabled", checkedAt: new Date().toISOString(), scanner: "test/disabled" } as const },
  };
}

describe("operations health", () => {
  it("keeps health details operator-only and returns the five governed checks", async () => {
    const repository = await createContentRepository({});
    const service = new OperationsHealthService(repository as unknown as OriginPostInfrastructure, disabledScanner(), new ConfigService({ OPERATIONS_PUBLISH_STALE_MINUTES: 30, OPERATIONS_OUTBOX_STALE_MINUTES: 15 }));
    await expect(service.view("default", { id: "viewer", name: "Viewer", role: "viewer" })).rejects.toBeInstanceOf(ForbiddenException);
    const view = await service.view("default", { id: "manager", name: "Manager", role: "manager" });
    expect(view.status).toBe("healthy");
    expect(view.checks.map((check) => check.id)).toEqual(["malware_protection", "webhook_delivery", "media_cleanup", "publishing_attention", "delivery_queue"]);
    expect(view.checks[0]).toMatchObject({ status: "disabled" });
  });

  it("opens one durable operator alert per incident and does not expose it to ordinary viewers", async () => {
    const repository = await createContentRepository({});
    repository.automationRepository.deliveryStatusSummary = async () => ({ counts: { dead_letter: 1 }, latestDeadLetterId: "delivery-one", latestDeadLetterAt: "2026-09-08T10:00:00.000Z" });
    const service = new OperationsHealthService(repository as unknown as OriginPostInfrastructure, disabledScanner(), new ConfigService({}));
    await service.evaluateFleetAndAlert();
    await service.evaluateFleetAndAlert();
    await expect(repository.notificationRepository.list("default", { includeOperatorAlerts: false })).resolves.toHaveLength(0);
    const alerts = await repository.notificationRepository.list("default", { includeOperatorAlerts: true });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ audience: "operators", kind: "system", severity: "error", actionUrl: "/?module=organizations#operations-health" });
  });
});
