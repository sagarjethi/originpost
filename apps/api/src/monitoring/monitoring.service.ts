import { ForbiddenException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { can, createMonitorRule, DomainError, updateMonitorRule } from "@originpost/domain";
import type { Actor } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { CreateMonitorDto, UpdateMonitorDto } from "./dto/monitor.dto.js";

@Injectable()
export class MonitoringService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure) {}
  async list(workspaceId: string, actor: Actor, brandId?: string) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view monitors.");
    return this.infrastructure.monitorRepository.list(workspaceId, brandId);
  }
  async runs(workspaceId: string, id: string) { await this.require(workspaceId, id); return this.infrastructure.monitorRepository.listRuns(workspaceId, id, 30) }

  async status(workspaceId: string, actor: Actor, brandId?: string) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view monitor health.");
    const monitors = await this.infrastructure.monitorRepository.list(workspaceId, brandId);
    return Promise.all(monitors.map(async (monitor) => {
      const runs = await this.infrastructure.monitorRepository.listRuns(workspaceId, monitor.id, 8);
      const lastRun = runs.find(run => run.status !== "skipped") ?? runs[0];
      const now = Date.now();
      const lateAfterMs = monitor.intervalMinutes * 2 * 60_000 + 5 * 60_000;
      const anchor = lastRun?.startedAt ?? monitor.createdAt;
      let health: "paused" | "waiting" | "healthy" | "running" | "failed" | "stale" | "coalesced" | "degraded" = "waiting";
      if (!monitor.enabled) health = "paused";
      else if (lastRun?.status === "failed") health = "failed";
      else if (lastRun?.status === "running") health = now - new Date(lastRun.startedAt).getTime() > lateAfterMs ? "stale" : "running";
      else if (lastRun?.status === "skipped") health = "coalesced";
      else if (lastRun?.status === "completed") health = now - new Date(lastRun.startedAt).getTime() > lateAfterMs ? "stale" : lastRun.reason?.startsWith("Partial source failure:") ? "degraded" : "healthy";
      else if (now - new Date(monitor.createdAt).getTime() > lateAfterMs) health = "stale";
      return {
        monitor,
        health,
        nextExpectedAt: monitor.enabled ? new Date(new Date(anchor).getTime() + monitor.intervalMinutes * 60_000).toISOString() : null,
        lastRun: lastRun ?? null,
        runs,
      };
    }));
  }

  private async require(workspaceId: string, id: string) {
    const monitor = await this.infrastructure.monitorRepository.get(workspaceId, id);
    if (!monitor) throw new DomainError("Monitor not found.", "monitor_not_found", 404);
    return monitor;
  }

  async create(dto: CreateMonitorDto, actor: Actor) {
    if (!can(actor.role, "automation:manage")) throw new ForbiddenException("You cannot manage monitors.");
    const queue = this.infrastructure.monitorQueue;
    if (!queue) throw new ServiceUnavailableException("Redis is required for monitoring.");
    const brands = await this.infrastructure.organizationRepository.listBrands(dto.workspaceId);
    const brandId = dto.brandId ?? brands[0]?.id;
    if (!brandId || !brands.some((brand) => brand.id === brandId)) throw new DomainError("The selected brand does not belong to this workspace.", "brand_not_found", 404);
    const monitor = createMonitorRule({
      workspaceId: dto.workspaceId, brandId, name: dto.name, query: dto.query, intervalMinutes: dto.intervalMinutes,
      depth: dto.depth, languages: dto.languages, ...(dto.region ? { region: dto.region } : {}), sourceLimit: dto.sourceLimit,
      freshnessHours: dto.freshnessHours, enabled: dto.enabled, ...(dto.notifyDestinationId ? { notifyDestinationId: dto.notifyDestinationId } : {}),
      ...(dto.sourceIntelligence ? { sourceIntelligence: dto.sourceIntelligence } : {}),
    }, actor);
    await this.infrastructure.monitorRepository.save(monitor);
    if (monitor.enabled) {
      await queue.upsertJobScheduler(monitor.id, { every: monitor.intervalMinutes * 60_000 }, { name: "run-monitor", data: { workspaceId: monitor.workspaceId, monitorId: monitor.id, trigger: "scheduled" } });
    }
    return monitor;
  }

  async update(workspaceId: string, id: string, dto: UpdateMonitorDto, actor: Actor) {
    if (!can(actor.role, "automation:manage")) throw new ForbiddenException("You cannot manage monitors.");
    const queue = this.infrastructure.monitorQueue;
    if (!queue) throw new ServiceUnavailableException("Redis is required for monitoring.");
    const monitor = updateMonitorRule(await this.require(workspaceId, id), dto, actor);
    await this.infrastructure.monitorRepository.save(monitor);
    if (monitor.enabled) await queue.upsertJobScheduler(monitor.id, { every: monitor.intervalMinutes * 60_000 }, { name: "run-monitor", data: { workspaceId, monitorId: id, trigger: "scheduled" } });
    else await queue.removeJobScheduler(monitor.id);
    return monitor;
  }

  async trigger(workspaceId: string, id: string, actor: Actor) {
    if (!can(actor.role, "automation:manage")) throw new ForbiddenException("You cannot run monitors.");
    const queue = this.infrastructure.monitorQueue;
    if (!queue) throw new ServiceUnavailableException("Redis is required for monitoring.");
    const monitor = await this.require(workspaceId, id);
    if (!monitor.enabled) throw new DomainError("Enable this monitor before running it.", "monitor_disabled", 409);
    const requestId = `monitor_manual_${crypto.randomUUID()}`;
    await queue.add("run-monitor", { workspaceId, monitorId: id, trigger: "manual", requestedBy: actor.id }, { jobId: requestId, attempts: 1, removeOnComplete: 500, removeOnFail: 1000 });
    return { accepted: true, requestId, monitorId: id };
  }
}
