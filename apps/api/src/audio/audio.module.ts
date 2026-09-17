import { AgentRuntimeModule } from '../agent-runtimes/agent-runtime.module.js';
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { MediaModule } from '../media/media.module.js';
import { AudioController } from './audio.controller.js';
import { AudioService } from './audio.service.js';
import { AudioProviders, ElevenLabsAudioProvider } from './audio-provider.js';
@Module({imports:[AgentRuntimeModule,InfrastructureModule,ChannelsModule,MediaModule],controllers:[AudioController],providers:[AudioService,AudioProviders,ElevenLabsAudioProvider]})
export class AudioModule {}
