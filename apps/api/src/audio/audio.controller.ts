import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { actorFrom, workspaceFrom } from '../common/request-context.js';
import { AudioService } from './audio.service.js';
import { AudioQueryDto, DraftAudioScriptDto, GenerateAudioDto, SaveAudioProfileDto } from './audio.dto.js';
@Controller({path:'audio',version:'1'})
export class AudioController {
  constructor(private readonly audio: AudioService) {}
  @Get() list(@Req() req: FastifyRequest,@Query() dto: AudioQueryDto) { return this.audio.list(workspaceFrom(req,dto.workspaceId),dto.brandId,actorFrom(req)); }
  @Post('profiles') create(@Req() req: FastifyRequest,@Body() dto: SaveAudioProfileDto) { return this.audio.save(workspaceFrom(req,dto.workspaceId),undefined,dto,actorFrom(req)); }
  @Patch('profiles/:id') update(@Req() req: FastifyRequest,@Param('id') id: string,@Body() dto: SaveAudioProfileDto) { return this.audio.save(workspaceFrom(req,dto.workspaceId),id,dto,actorFrom(req)); }
  @Get('profiles/:id/catalogue') catalogue(@Req() req: FastifyRequest,@Param('id') id: string,@Query() dto: AudioQueryDto) { return this.audio.catalogue(workspaceFrom(req,dto.workspaceId),dto.brandId,id,actorFrom(req),dto.cursor); }
  @Post('draft-script') draft(@Req() req: FastifyRequest,@Body() dto: DraftAudioScriptDto) { return this.audio.draft(workspaceFrom(req,dto.workspaceId),dto,actorFrom(req)); }
  @Post('generations') generate(@Req() req: FastifyRequest,@Body() dto: GenerateAudioDto) { return this.audio.generate(workspaceFrom(req,dto.workspaceId),dto,actorFrom(req)); }
}
