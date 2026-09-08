import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { discoverPluginCatalog } from "@originpost/connectors";
import { can, type Actor } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { OutboxQueryDto } from "./system.dto.js";
import { OperationsHealthService } from "./operations-health.service.js";

@Injectable()
export class SystemService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure, private readonly config: ConfigService, private readonly operationsHealth: OperationsHealthService) {}

  health() { return { status: "ok", service: "originpost-api", framework: "nestjs", storage: this.infrastructure.storageMode } }
  connectors() { return this.infrastructure.connectors.list().map((connector) => connector.manifest) }
  async agents() { return { hermes: { configured: Boolean(this.infrastructure.hermes), healthy: this.infrastructure.hermes ? await this.infrastructure.hermes.health() : false }, sourcing: { mode: this.config.get<string>("AGENT_MODE") ?? "mock", ready: this.config.get<string>("AGENT_MODE") !== "hermes" || Boolean(this.infrastructure.hermes) } } }
  plugins() {
    const configured = this.config.get<string>("PLUGIN_DIRECTORY")?.trim();
    return discoverPluginCatalog({ ...(configured ? { rootDir: configured } : {}) });
  }
  outboxStats(workspaceId = "default") { return this.infrastructure.outboxRepository.stats(workspaceId) }
  outboxMessages(query: OutboxQueryDto) { return this.infrastructure.outboxRepository.list(query.workspaceId, query.status, query.limit) }
  operations(workspaceId: string, actor: Actor) { return this.operationsHealth.view(workspaceId, actor) }
  async retryOutbox(workspaceId: string, id: string, actor: Actor) {
    if (!can(actor.role, "automation:manage")) throw new ForbiddenException("You cannot retry publishing operations.");
    if (!await this.infrastructure.outboxRepository.retry(workspaceId, id)) throw new NotFoundException("Failed outbox message not found.");
    return { retried: true, id };
  }
}
