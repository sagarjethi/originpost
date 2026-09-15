import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { createMonitorRule, InMemoryMonitorRepository, type Actor, type MonitorRun } from "@originpost/domain";
import { describe, expect, it, vi } from "vitest";
import { INFRASTRUCTURE } from "../src/common/tokens.js";
import { MonitoringService } from "../src/monitoring/monitoring.service.js";

const owner: Actor = { id: "owner", name: "Owner", role: "owner" };

describe("MonitoringService", () => {
  it("returns workspace-scoped failed health and queues a manual run", async () => {
    const monitorRepository = new InMemoryMonitorRepository();
    const queue = { add: vi.fn(async () => ({ id: "job" })), upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [MonitoringService, { provide: INFRASTRUCTURE, useValue: { monitorRepository, monitorQueue: queue } }],
    }).compile();
    const service = module.get(MonitoringService);
    const monitor = createMonitorRule({ workspaceId: "one", brandId: "brand-1", name: "Daily brief", query: "daily brief", intervalMinutes: 15, depth: "standard", languages: ["English"], sourceLimit: 8, freshnessHours: 24, enabled: true }, owner, new Date().toISOString());
    await monitorRepository.save(monitor);
    const run: MonitorRun = { id: "run-1", workspaceId: "one", monitorId: monitor.id, status: "running", trigger: "scheduled", discoveredCount: 0, newCount: 0, startedAt: new Date().toISOString() };
    await monitorRepository.startRun(run);
    await monitorRepository.finishRun({ ...run, status: "failed", error: "Required sourcing skill did not load.", completedAt: new Date().toISOString() }, []);

    const status = await service.status("one", owner);
    expect(status[0]).toMatchObject({ health: "failed", lastRun: { status: "failed", error: "Required sourcing skill did not load." } });
    expect(await service.status("two", owner)).toEqual([]);

    const accepted = await service.trigger("one", monitor.id, owner);
    expect(accepted).toMatchObject({ accepted: true, monitorId: monitor.id });
    expect(queue.add).toHaveBeenCalledWith("run-monitor", expect.objectContaining({ workspaceId: "one", monitorId: monitor.id, trigger: "manual", requestedBy: owner.id }), expect.objectContaining({ attempts: 1 }));
  });
});
