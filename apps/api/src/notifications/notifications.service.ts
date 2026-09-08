import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { can, DomainError, type Actor } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { NotificationListQueryDto } from "./dto/notification.dto.js";

@Injectable()
export class NotificationsService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure) {}

  private authorize(actor: Actor): void {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view notifications.");
  }

  private options(actor: Actor) {
    return { includeOperatorAlerts: can(actor.role, "automation:manage") };
  }

  async list(workspaceId: string, query: NotificationListQueryDto, actor: Actor) {
    this.authorize(actor);
    return this.infrastructure.notificationRepository.list(workspaceId, { unreadOnly: query.unreadOnly, limit: query.limit, ...this.options(actor) });
  }

  async summary(workspaceId: string, actor: Actor) {
    this.authorize(actor);
    return { unread: await this.infrastructure.notificationRepository.countUnread(workspaceId, this.options(actor)) };
  }

  async markRead(workspaceId: string, id: string, actor: Actor) {
    this.authorize(actor);
    const notification = await this.infrastructure.notificationRepository.markRead(workspaceId, id, actor.id, new Date().toISOString(), this.options(actor));
    if (!notification) throw new DomainError("Notification not found.", "notification_not_found", 404);
    return notification;
  }

  async markAllRead(workspaceId: string, actor: Actor) {
    this.authorize(actor);
    return { updated: await this.infrastructure.notificationRepository.markAllRead(workspaceId, actor.id, new Date().toISOString(), this.options(actor)) };
  }
}
