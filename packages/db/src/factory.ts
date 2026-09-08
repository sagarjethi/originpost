import {
  InMemoryContentItemRepository,
  InMemoryAnalyticsRepository,
  InMemoryAnalyticsReportRepository,
  InMemoryAutomationRepository,
  InMemoryBatchPlanRepository,
  InMemoryCreativeStudioRepository,
  InMemoryShareCaptureRepository,
  InMemorySourceSignalRepository,
  InMemoryAuthRepository,
  InMemoryConnectedAccountRepository,
  InMemoryEngagementRepository,
  InMemoryEvergreenRepository,
  InMemoryAgentRuntimeRepository,
  InMemoryAgentBoardRepository,
  InMemoryMediaRepository,
  InMemoryMediaOrganizationRepository,
  InMemoryMonitorRepository,
  InMemoryNotificationRepository,
  InMemoryOrganizationRepository,
  InMemoryOAuthRepository,
  InMemoryOutboxRepository,
  InMemoryProviderPublishOperationRepository,
  InMemoryFirstCommentRepository,
  InMemoryPostingQueueRepository,
  InMemoryOperationalIncidentRepository,
  type ContentItemRepository,
  type AnalyticsRepository,
  type AnalyticsReportRepository,
  type AutomationRepository,
  type BatchPlanRepository,
  type CreativeStudioRepository,
  type ShareCaptureRepository,
  type SourceSignalRepository,
  type AuthRepository,
  type ConnectedAccountRepository,
  type EngagementRepository,
  type EvergreenRepository,
  type AgentRuntimeRepository,
  type AgentBoardRepository,
  type MediaRepository,
  type MediaOrganizationRepository,
  type MonitorRepository,
  type NotificationRepository,
  type OrganizationRepository,
  type OAuthRepository,
  type OutboxRepository,
  type ProviderPublishOperationRepository,
  type ProviderLifecycleRepository,
  type FirstCommentRepository,
  type PostingQueueRepository,
  type RemoteCorrectionRepository,
  type InstagramCollaboratorRepository,
  type PrivateConversationRepository,
  type OperationalIncidentRepository,
} from "@originpost/domain";
import { InMemoryInstagramCollaboratorRepository, PostgresInstagramCollaboratorRepository } from "./instagram-collaborator-repository.js";
import { InMemoryRemoteCorrectionRepository } from "./in-memory-remote-correction-repository.js";
import { PostgresRemoteCorrectionRepository } from "./postgres-remote-correction-repository.js";
import { PostgresMonitorRepository } from "./postgres-monitor-repository.js";
import { PostgresMediaRepository } from "./postgres-media-repository.js";
import { PostgresMediaOrganizationRepository } from "./postgres-media-organization-repository.js";
import { PostgresOutboxRepository } from "./postgres-outbox-repository.js";
import { createPostgresClient, PostgresContentItemRepository } from "./postgres-repository.js";
import { PostgresConnectedAccountRepository } from "./postgres-connected-account-repository.js";
import { PostgresProviderLifecycleRepository } from "./postgres-provider-lifecycle-repository.js";
import { PostgresAuthRepository } from "./postgres-auth-repository.js";
import { PostgresOAuthRepository } from "./postgres-oauth-repository.js";
import { PostgresProviderPublishOperationRepository } from "./postgres-provider-publish-operation-repository.js";
import { PostgresNotificationRepository } from "./postgres-notification-repository.js";
import { PostgresOperationalIncidentRepository } from "./postgres-operational-incident-repository.js";
import { PostgresOrganizationRepository } from "./postgres-organization-repository.js";
import { PostgresAnalyticsRepository } from "./postgres-analytics-repository.js";
import { PostgresAnalyticsReportRepository } from "./postgres-analytics-report-repository.js";
import { PostgresAutomationRepository } from "./postgres-automation-repository.js";
import { PostgresBatchPlanRepository } from "./postgres-batch-plan-repository.js";
import { PostgresCreativeStudioRepository } from "./postgres-creative-studio-repository.js";
import { PostgresShareCaptureRepository } from "./postgres-share-capture-repository.js";
import { PostgresSourceSignalRepository } from "./postgres-source-signal-repository.js";
import { PostgresEngagementRepository } from "./postgres-engagement-repository.js";
import { PostgresEvergreenRepository } from "./postgres-evergreen-repository.js";
import { PostgresAgentRuntimeRepository } from "./postgres-agent-runtime-repository.js";
import { PostgresAgentBoardRepository } from "./postgres-agent-board-repository.js";
import { PostgresFirstCommentRepository } from "./postgres-first-comment-repository.js";
import { PostgresPostingQueueRepository } from "./postgres-posting-queue-repository.js";
import { InMemoryPrivateConversationRepository } from "./in-memory-private-conversation-repository.js";
import { PostgresPrivateConversationRepository } from "./postgres-private-conversation-repository.js";
import { decodePrivateKey, type PrivateConversationKeys } from "./private-conversation-crypto.js";

function privateMessageKeys(options: { privateMessageEncryptionKey?: string | Buffer; privateMessageHashKey?: string | Buffer; privateMessageTestMode?: boolean }): PrivateConversationKeys | null {
  if (!options.privateMessageEncryptionKey && !options.privateMessageHashKey) {
    return options.privateMessageTestMode ? { encryptionKey: Buffer.alloc(32, 0x31), hashKey: Buffer.alloc(32, 0x71) } : null;
  }
  const encryptionKey = decodePrivateKey(options.privateMessageEncryptionKey, 32);
  const hashKey = decodePrivateKey(options.privateMessageHashKey, 32);
  if (!encryptionKey || encryptionKey.length !== 32 || !hashKey) throw new Error("PRIVATE_MESSAGE_ENCRYPTION_KEY must be exactly 32 bytes and PRIVATE_MESSAGE_HASH_KEY must be at least 32 bytes.");
  return { encryptionKey, hashKey };
}

export async function createContentRepository(options: {
  databaseUrl?: string;
  allowMemoryFallback?: boolean;
  privateMessageEncryptionKey?: string | Buffer;
  privateMessageHashKey?: string | Buffer;
  privateMessageTestMode?: boolean;
}): Promise<{ repository: ContentItemRepository; postingQueueRepository: PostingQueueRepository; analyticsRepository: AnalyticsRepository; analyticsReportRepository: AnalyticsReportRepository; automationRepository: AutomationRepository; batchPlanRepository: BatchPlanRepository; creativeStudioRepository: CreativeStudioRepository; shareCaptureRepository: ShareCaptureRepository; sourceSignalRepository: SourceSignalRepository; engagementRepository: EngagementRepository; firstCommentRepository: FirstCommentRepository; evergreenRepository: EvergreenRepository; agentRuntimeRepository: AgentRuntimeRepository; agentBoardRepository: AgentBoardRepository; privateConversationRepository: PrivateConversationRepository | null; authRepository: AuthRepository; organizationRepository: OrganizationRepository; oauthRepository: OAuthRepository; connectedAccountRepository: ConnectedAccountRepository; providerLifecycleRepository: ProviderLifecycleRepository; mediaRepository: MediaRepository; mediaOrganizationRepository: MediaOrganizationRepository; monitorRepository: MonitorRepository; notificationRepository: NotificationRepository; operationalIncidentRepository: OperationalIncidentRepository; outboxRepository: OutboxRepository; providerPublishOperationRepository: ProviderPublishOperationRepository; remoteCorrectionRepository: RemoteCorrectionRepository; instagramCollaboratorRepository: InstagramCollaboratorRepository; mode: "postgres" | "memory" }> {
  const privateKeys = privateMessageKeys(options);
  if (!options.databaseUrl) {
    const outboxRepository = new InMemoryOutboxRepository();
    const oauthRepository = new InMemoryOAuthRepository();
    const notificationRepository = new InMemoryNotificationRepository();
    const providerPublishOperationRepository = new InMemoryProviderPublishOperationRepository();
    const monitorRepository = new InMemoryMonitorRepository();
    const authRepository = new InMemoryAuthRepository();
    const automationRepository = new InMemoryAutomationRepository();
    const repository = new InMemoryContentItemRepository(outboxRepository, providerPublishOperationRepository, monitorRepository, automationRepository);
    const creativeStudioRepository = new InMemoryCreativeStudioRepository();
    const mediaRepository = new InMemoryMediaRepository(repository, creativeStudioRepository);
    const connectedAccountRepository = new InMemoryConnectedAccountRepository(oauthRepository, notificationRepository);
    return { repository, postingQueueRepository: new InMemoryPostingQueueRepository(repository), analyticsRepository: new InMemoryAnalyticsRepository(), analyticsReportRepository: new InMemoryAnalyticsReportRepository(), automationRepository, batchPlanRepository: new InMemoryBatchPlanRepository(), creativeStudioRepository, shareCaptureRepository: new InMemoryShareCaptureRepository(), sourceSignalRepository: new InMemorySourceSignalRepository(), engagementRepository: new InMemoryEngagementRepository(), firstCommentRepository: new InMemoryFirstCommentRepository(repository), evergreenRepository: new InMemoryEvergreenRepository(), agentRuntimeRepository: new InMemoryAgentRuntimeRepository(), agentBoardRepository: new InMemoryAgentBoardRepository((messages)=>outboxRepository.append(messages)), privateConversationRepository: privateKeys ? new InMemoryPrivateConversationRepository(privateKeys) : null, authRepository, organizationRepository: new InMemoryOrganizationRepository((membership) => authRepository.addWorkspaceMembership(membership)), oauthRepository, connectedAccountRepository, providerLifecycleRepository: connectedAccountRepository, mediaRepository, mediaOrganizationRepository: new InMemoryMediaOrganizationRepository(mediaRepository), monitorRepository, notificationRepository, operationalIncidentRepository: new InMemoryOperationalIncidentRepository(), outboxRepository, providerPublishOperationRepository, remoteCorrectionRepository: new InMemoryRemoteCorrectionRepository(outboxRepository), instagramCollaboratorRepository: new InMemoryInstagramCollaboratorRepository(repository), mode: "memory" };
  }

  const sql = createPostgresClient(options.databaseUrl);
  try {
    await sql`select 1`;
    const repository = new PostgresContentItemRepository(sql);
    return { repository, postingQueueRepository: new PostgresPostingQueueRepository(sql), analyticsRepository: new PostgresAnalyticsRepository(sql), analyticsReportRepository: new PostgresAnalyticsReportRepository(sql), automationRepository: new PostgresAutomationRepository(sql), batchPlanRepository: new PostgresBatchPlanRepository(sql), creativeStudioRepository: new PostgresCreativeStudioRepository(sql), shareCaptureRepository: new PostgresShareCaptureRepository(sql), sourceSignalRepository: new PostgresSourceSignalRepository(sql), engagementRepository: new PostgresEngagementRepository(sql), firstCommentRepository: new PostgresFirstCommentRepository(sql), evergreenRepository: new PostgresEvergreenRepository(sql), agentRuntimeRepository: new PostgresAgentRuntimeRepository(sql), agentBoardRepository: new PostgresAgentBoardRepository(sql), privateConversationRepository: privateKeys ? new PostgresPrivateConversationRepository(sql, privateKeys) : null, authRepository: new PostgresAuthRepository(sql), organizationRepository: new PostgresOrganizationRepository(sql), oauthRepository: new PostgresOAuthRepository(sql), connectedAccountRepository: new PostgresConnectedAccountRepository(sql), providerLifecycleRepository: new PostgresProviderLifecycleRepository(sql), mediaRepository: new PostgresMediaRepository(sql), mediaOrganizationRepository: new PostgresMediaOrganizationRepository(sql), monitorRepository: new PostgresMonitorRepository(sql), notificationRepository: new PostgresNotificationRepository(sql), operationalIncidentRepository: new PostgresOperationalIncidentRepository(sql), outboxRepository: new PostgresOutboxRepository(sql), providerPublishOperationRepository: new PostgresProviderPublishOperationRepository(sql), remoteCorrectionRepository: new PostgresRemoteCorrectionRepository(sql), instagramCollaboratorRepository: new PostgresInstagramCollaboratorRepository(sql), mode: "postgres" };
  } catch (error) {
    await sql.end({ timeout: 1 });
    if (!options.allowMemoryFallback) {
      throw error;
    }
    const outboxRepository = new InMemoryOutboxRepository();
    const oauthRepository = new InMemoryOAuthRepository();
    const notificationRepository = new InMemoryNotificationRepository();
    const providerPublishOperationRepository = new InMemoryProviderPublishOperationRepository();
    const monitorRepository = new InMemoryMonitorRepository();
    const authRepository = new InMemoryAuthRepository();
    const automationRepository = new InMemoryAutomationRepository();
    const repository = new InMemoryContentItemRepository(outboxRepository, providerPublishOperationRepository, monitorRepository, automationRepository);
    const creativeStudioRepository = new InMemoryCreativeStudioRepository();
    const mediaRepository = new InMemoryMediaRepository(repository, creativeStudioRepository);
    const connectedAccountRepository = new InMemoryConnectedAccountRepository(oauthRepository, notificationRepository);
    return { repository, postingQueueRepository: new InMemoryPostingQueueRepository(repository), analyticsRepository: new InMemoryAnalyticsRepository(), analyticsReportRepository: new InMemoryAnalyticsReportRepository(), automationRepository, batchPlanRepository: new InMemoryBatchPlanRepository(), creativeStudioRepository, shareCaptureRepository: new InMemoryShareCaptureRepository(), sourceSignalRepository: new InMemorySourceSignalRepository(), engagementRepository: new InMemoryEngagementRepository(), firstCommentRepository: new InMemoryFirstCommentRepository(repository), evergreenRepository: new InMemoryEvergreenRepository(), agentRuntimeRepository: new InMemoryAgentRuntimeRepository(), agentBoardRepository: new InMemoryAgentBoardRepository((messages)=>outboxRepository.append(messages)), privateConversationRepository: privateKeys ? new InMemoryPrivateConversationRepository(privateKeys) : null, authRepository, organizationRepository: new InMemoryOrganizationRepository((membership) => authRepository.addWorkspaceMembership(membership)), oauthRepository, connectedAccountRepository, providerLifecycleRepository: connectedAccountRepository, mediaRepository, mediaOrganizationRepository: new InMemoryMediaOrganizationRepository(mediaRepository), monitorRepository, notificationRepository, operationalIncidentRepository: new InMemoryOperationalIncidentRepository(), outboxRepository, providerPublishOperationRepository, remoteCorrectionRepository: new InMemoryRemoteCorrectionRepository(outboxRepository), instagramCollaboratorRepository: new InMemoryInstagramCollaboratorRepository(repository), mode: "memory" };
  }
}
