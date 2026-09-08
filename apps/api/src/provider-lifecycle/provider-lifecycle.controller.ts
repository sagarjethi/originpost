import { Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Public } from "../common/public.decorator.js";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { WorkspaceQueryDto } from "../content/dto/content.dto.js";
import { ProviderLifecycleService } from "./provider-lifecycle.service.js";

type RawRequest = FastifyRequest & { rawBody?: Buffer };

@Controller({ version: "1" })
export class ProviderLifecycleController {
  constructor(private readonly lifecycle: ProviderLifecycleService) {}

  @Get("channels/provider-grants")
  list(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto) {
    return this.lifecycle.list(workspaceFrom(request, query.workspaceId), actorFrom(request), query.brandId);
  }

  @Public() @Post("channels/callbacks/meta/deauthorization") @HttpCode(200)
  receiveDeauthorization(@Req() request: RawRequest, @Headers("content-type") contentType?: string) {
    return this.lifecycle.receiveMetaDeauthorization(request.rawBody, contentType);
  }

  @Public() @Post("channels/callbacks/meta/data-deletion") @HttpCode(200)
  receiveDataDeletion(@Req() request: RawRequest, @Headers("content-type") contentType?: string) {
    return this.lifecycle.receiveMetaDataDeletion(request.rawBody, contentType);
  }

  @Public() @Get("provider-data-deletions/:code")
  async deletionStatus(@Param("code") code: string, @Res() reply: FastifyReply) {
    const status = await this.lifecycle.deletionStatus(code);
    const title = status.status === "completed" ? "Deletion complete" : status.status === "needs_review" ? "Deletion needs review" : "Deletion in progress";
    const body = status.status === "completed" ? "OriginPost removed the provider-derived data covered by this request. Workspace-authored drafts and media were retained." : status.status === "needs_review" ? "OriginPost could not finish this deletion automatically. The request has been retained for operator review." : "OriginPost is removing provider-derived data. Please check this page again later.";
    reply.header("cache-control", "no-store, max-age=0").header("pragma", "no-cache").header("x-robots-tag", "noindex, nofollow").type("text/html; charset=utf-8");
    return reply.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · OriginPost</title><style>body{margin:0;background:#070b14;color:#eef2ff;font:16px/1.55 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.card{width:min(560px,calc(100% - 40px));background:#111827;border:1px solid #334155;border-radius:20px;padding:32px;box-shadow:0 24px 70px #0008}p{color:#cbd5e1}small{color:#94a3b8}</style></head><body><main class="card"><small>ORIGINPOST · PROVIDER DATA</small><h1>${title}</h1><p>${body}</p><small>Requested ${status.requestedAt}${status.completedAt ? ` · Completed ${status.completedAt}` : ""}</small></main></body></html>`);
  }
}
