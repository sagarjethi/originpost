import { Body, Controller, Get, Header, Put, Req, Version } from '@nestjs/common';
import type { AuthenticatedRequest } from '../common/auth-context.guard.js';
import { InstallationService } from './installation.service.js';

@Controller('installation/settings')
export class InstallationController {
  constructor(private readonly installation: InstallationService) {}
  @Get() @Header('Cache-Control','no-store') @Version('1') get(@Req() request: AuthenticatedRequest) { return this.installation.get(request); }
  @Put() @Header('Cache-Control','no-store') @Version('1') save(@Req() request: AuthenticatedRequest,@Body() input: {version:number;values:Record<string,string>;clearSecrets?:string[]}) { return this.installation.save(request,input); }
}
