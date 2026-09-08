import type { PrivateConversationRepository, ProviderLifecycleRepository } from "@originpost/domain";

export interface ProviderDataDeletionJob {
  workspaceId: string;
  deletionRequestId: string;
}

export async function processProviderDataDeletion(
  job: ProviderDataDeletionJob,
  dependencies: {
    lifecycle: ProviderLifecycleRepository;
    privateConversations: PrivateConversationRepository | null;
  },
): Promise<{ skipped: boolean; deletedPrivateData?: number }> {
  const scope = await dependencies.lifecycle.getDataDeletionScope(job.deletionRequestId, job.workspaceId);
  if (!scope || scope.status === "completed") return { skipped: true };
  if (scope.status === "needs_review") return { skipped: true };
  if (scope.hasPrivateData && !dependencies.privateConversations) {
    throw new Error("Private provider data exists but the private-data erasure keys are unavailable.");
  }
  let deletedPrivateData = 0;
  if (dependencies.privateConversations && scope.accountIds.length) {
    const erased = await dependencies.privateConversations.eraseProviderData(job.workspaceId, scope.accountIds, new Date().toISOString());
    deletedPrivateData = erased.conversations + erased.participants + erased.messages + erased.replyIntents + erased.receipts;
  }
  await dependencies.lifecycle.processDataDeletionScope(job.deletionRequestId, job.workspaceId, new Date().toISOString());
  return { skipped: false, deletedPrivateData };
}
