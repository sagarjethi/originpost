import { Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { NotificationListQueryDto, NotificationParamDto, NotificationWorkspaceParamDto } from "./dto/notification.dto.js";
import { NotificationsService } from "./notifications.service.js";

@Controller({ path: "workspaces/:workspaceId/notifications", version: "1" })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Req() request: FastifyRequest, @Param() params: NotificationWorkspaceParamDto, @Query() query: NotificationListQueryDto) {
    return this.notifications.list(workspaceFrom(request, params.workspaceId), query, actorFrom(request));
  }

  @Get("summary")
  summary(@Req() request: FastifyRequest, @Param() params: NotificationWorkspaceParamDto) {
    return this.notifications.summary(workspaceFrom(request, params.workspaceId), actorFrom(request));
  }

  @Patch(":id/read")
  read(@Req() request: FastifyRequest, @Param() params: NotificationParamDto) {
    return this.notifications.markRead(workspaceFrom(request, params.workspaceId), params.id, actorFrom(request));
  }

  @Post("read-all")
  readAll(@Req() request: FastifyRequest, @Param() params: NotificationWorkspaceParamDto) {
    return this.notifications.markAllRead(workspaceFrom(request, params.workspaceId), actorFrom(request));
  }
}
