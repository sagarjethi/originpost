import type {
  PrivateConversationParticipantView,
  PrivateConversationRecordView,
  PrivateConversationSummary,
  PrivateConversationView,
  PrivateMessageAttachment,
  PrivateMessageView,
  PrivateReplyEligibility,
  PrivateReplyIntent,
  PrivateReplyIntentView,
} from "@originpost/domain";

function attachment(value: PrivateMessageAttachment) {
  return {
    id: value.id,
    kind: value.kind,
    ...(value.mimeType ? { mimeType: value.mimeType } : {}),
    ...(value.sizeBytes !== undefined ? { sizeBytes: value.sizeBytes } : {}),
    ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
    cachePolicy: value.cachePolicy,
    availability: value.availability,
  };
}

function eligibility(value: PrivateReplyEligibility) {
  return {
    state: value.state,
    checkedAt: value.checkedAt,
    ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
    ...(value.reason ? { reason: value.reason } : {}),
    contractVersion: value.contractVersion,
    ...(value.evidence ? {
      evidence: {
        mode: value.evidence.mode,
        qualifyingEventAt: value.evidence.qualifyingEventAt,
        durationSeconds: value.evidence.durationSeconds,
        ...(value.evidence.mode === "human_agent" ? {
          review: {
            reviewedAt: value.evidence.review.reviewedAt,
            ...(value.evidence.review.expiresAt ? { expiresAt: value.evidence.review.expiresAt } : {}),
            humanOnly: true as const,
            contractVersion: value.evidence.review.contractVersion,
          },
        } : {}),
      },
    } : {}),
  };
}

function conversation(value: PrivateConversationRecordView) {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    brandId: value.brandId,
    accountId: value.accountId,
    platform: value.platform,
    connectionMode: value.connectionMode,
    state: value.state,
    ...(value.assignedTo ? { assignedTo: value.assignedTo } : {}),
    ...(value.lastInboundAt ? { lastInboundAt: value.lastInboundAt } : {}),
    ...(value.lastOutboundAt ? { lastOutboundAt: value.lastOutboundAt } : {}),
    lastActivityAt: value.lastActivityAt,
    ...(value.lastSyncedAt ? { lastSyncedAt: value.lastSyncedAt } : {}),
    ...(value.resolvedAt ? { resolvedAt: value.resolvedAt } : {}),
    version: value.version,
  };
}

function participant(value: PrivateConversationParticipantView) {
  return {
    id: value.id,
    conversationId: value.conversationId,
    accountId: value.accountId,
    role: value.role,
    ...(value.displayName ? { displayName: value.displayName } : {}),
    ...(value.username ? { username: value.username } : {}),
    ...(value.avatarUrl ? { avatarUrl: value.avatarUrl } : {}),
    ...(value.avatarExpiresAt ? { avatarExpiresAt: value.avatarExpiresAt } : {}),
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt,
  };
}

function message(value: PrivateMessageView) {
  return {
    id: value.id,
    conversationId: value.conversationId,
    accountId: value.accountId,
    platform: value.platform,
    connectionMode: value.connectionMode,
    ...(value.senderParticipantId ? { senderParticipantId: value.senderParticipantId } : {}),
    direction: value.direction,
    kind: value.kind,
    ...(value.body !== undefined ? { body: value.body } : {}),
    attachments: value.attachments.map(attachment),
    ...(value.replyToMessageId ? { replyToMessageId: value.replyToMessageId } : {}),
    isEcho: value.isEcho,
    availability: value.availability,
    deliveryState: value.deliveryState,
    ...(value.deliveredAt ? { deliveredAt: value.deliveredAt } : {}),
    ...(value.readAt ? { readAt: value.readAt } : {}),
    ...(value.deletedAt ? { deletedAt: value.deletedAt } : {}),
    ...(value.providerCreatedAt ? { providerCreatedAt: value.providerCreatedAt } : {}),
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt,
    source: value.source,
    observationKind: value.observationKind,
  };
}

export function privateReplyIntentResponse(value: PrivateReplyIntent | PrivateReplyIntentView) {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    brandId: value.brandId,
    conversationId: value.conversationId,
    inReplyToMessageId: value.inReplyToMessageId,
    body: value.body,
    status: value.status,
    requestedBy: value.requestedBy,
    ...(value.approvedBy ? { approvedBy: value.approvedBy } : {}),
    ...(value.eligibilityAtApproval ? { eligibilityAtApproval: eligibility(value.eligibilityAtApproval) } : {}),
    ...(value.providerAcceptedAt ? { providerAcceptedAt: value.providerAcceptedAt } : {}),
    providerEvidenceAvailable: Boolean(value.providerAcceptedAt),
    ...(value.errorCode ? { errorCode: value.errorCode } : {}),
    ...(value.errorSummary ? { errorSummary: value.errorSummary } : {}),
    attemptCount: value.attemptCount,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.completedAt ? { completedAt: value.completedAt } : {}),
    version: value.version,
  };
}

export function privateConversationSummaryResponse(value: PrivateConversationSummary) {
  return {
    conversation: conversation(value.conversation),
    participants: value.participants.map(participant),
    ...(value.latestMessage ? { latestMessage: message(value.latestMessage) } : {}),
    unreadCount: value.unreadCount,
    needsReply: value.needsReply,
    replyEligibility: eligibility(value.replyEligibility),
  };
}

export function privateConversationViewResponse(value: PrivateConversationView) {
  return {
    conversation: conversation(value.conversation),
    participants: value.participants.map(participant),
    messages: value.messages.map(message),
    replyIntents: value.replyIntents.map(privateReplyIntentResponse),
    replyEligibility: eligibility(value.replyEligibility),
  };
}

export function privateConversationRecordResponse(value: PrivateConversationRecordView) {
  return conversation(value);
}
