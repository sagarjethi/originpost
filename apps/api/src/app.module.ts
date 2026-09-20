import { AudioModule } from './audio/audio.module.js';
import { AgentPostsModule } from "./agent-posts/agent-posts.module.js";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { AuthContextGuard } from "./common/auth-context.guard.js";
import { ContentModule } from "./content/content.module.js";
import { InfrastructureModule } from "./infrastructure/infrastructure.module.js";
import { MonitoringModule } from "./monitoring/monitoring.module.js";
import { MediaModule } from "./media/media.module.js";
import { SystemModule } from "./system/system.module.js";
import { ChannelsModule } from "./channels/channels.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { NotificationsModule } from "./notifications/notifications.module.js";
import { OrganizationsModule } from "./organizations/organizations.module.js";
import { AnalyticsModule } from "./analytics/analytics.module.js";
import { EngagementModule } from "./engagement/engagement.module.js";
import { AutomationModule } from "./automation/automation.module.js";
import { RemoteCorrectionModule } from "./remote-correction/remote-correction.module.js";
import { PrivateConversationsModule } from "./private-conversations/private-conversations.module.js";
import { BatchOperationsModule } from "./batch-operations/batch-operations.module.js";
import { ShareCaptureModule } from "./share-capture/share-capture.module.js";
import { SourceSignalsModule } from "./source-signals/source-signals.module.js";
import { EvergreenModule } from "./evergreen/evergreen.module.js";
import { AgentRuntimeModule } from "./agent-runtimes/agent-runtime.module.js";
import { CreativeStudioModule } from "./creative-studio/creative-studio.module.js";
import { ImageGenerationModule } from "./image-generation/image-generation.module.js";
import { FirstCommentModule } from "./first-comments/first-comment.module.js";
import { PostingQueueModule } from "./posting-queues/posting-queue.module.js";
import { BoardsModule } from "./boards/boards.module.js";
import { ProviderLifecycleModule } from "./provider-lifecycle/provider-lifecycle.module.js";
import { validateConfig } from "./configuration.js";
export { validateConfig } from "./configuration.js";
import { InstallationModule } from "./installation/installation.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateConfig }),
    InfrastructureModule,
    InstallationModule,
    AuthModule,
    ContentModule,
    MonitoringModule,
    MediaModule,
    AudioModule,
    SystemModule,
    ChannelsModule,
    NotificationsModule,
    OrganizationsModule,
    AnalyticsModule,
    EngagementModule,
    AutomationModule,
    RemoteCorrectionModule,
    PrivateConversationsModule,
    BatchOperationsModule,
    ShareCaptureModule,
    SourceSignalsModule,
    EvergreenModule,
    AgentRuntimeModule,
    CreativeStudioModule,
    ImageGenerationModule,
    AgentPostsModule,
    FirstCommentModule,
    PostingQueueModule,
    BoardsModule,
    ProviderLifecycleModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthContextGuard }],
})
export class AppModule {}
