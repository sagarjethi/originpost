import type { CollaboratorInviteProof, CurrentCollaboratorStatusSnapshot, InstagramCollaboratorCapability, InstagramPublishSettings } from "./instagram-collaboration.js";
import type { Approval, AuditEvent, ContentItem } from "./types.js";

export type InstagramCollaboratorCandidateStatus = "pending_approval" | "approved";

export interface InstagramCollaboratorCandidate {
  id: string;
  workspaceId: string;
  brandId: string;
  contentItemId: string;
  draftId: string;
  draftSha256: string;
  accountId: string;
  publishingUsername: string;
  settings: InstagramPublishSettings;
  status: InstagramCollaboratorCandidateStatus;
  requestedBy: string;
  requestedAt: string;
  approvalId?: string | undefined;
  approvedBy?: string | undefined;
  approvedAt?: string | undefined;
}

export interface InstagramCollaboratorPoll {
  workspaceId: string;
  brandId: string;
  contentItemId: string;
  proofId: string;
  accountId: string;
  externalMediaId: string;
  inviteProof: Extract<CollaboratorInviteProof, { requestState: "requested_unverified" }>;
  status: "pending" | "processing" | "complete" | "unavailable" | "expired";
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  expiresAt: string;
  availability?: string | undefined;
  errorSummary?: string | undefined;
  capturedAt?: string | undefined;
  latestReadComplete?: boolean | undefined;
  rawResponseSha256?: string | undefined;
  updatedAt: string;
  claimId?: string | undefined;
  claimLeaseExpiresAt?: string | undefined;
}

export interface InstagramCollaboratorStatusView {
  poll: InstagramCollaboratorPoll | null;
  snapshots: CurrentCollaboratorStatusSnapshot[];
}

export interface InstagramCollaboratorRepository {
  createCandidate(candidate: InstagramCollaboratorCandidate): Promise<InstagramCollaboratorCandidate>;
  getCandidate(workspaceId: string, contentItemId: string, candidateId: string): Promise<InstagramCollaboratorCandidate | null>;
  getApprovedCandidate(workspaceId: string, contentItemId: string, approvalId: string): Promise<InstagramCollaboratorCandidate | null>;
  listCandidates(workspaceId: string, contentItemId: string): Promise<InstagramCollaboratorCandidate[]>;
  approveCandidate(workspaceId: string, contentItemId: string, candidateId: string, approval: { id: string; actorId: string; createdAt: string }): Promise<InstagramCollaboratorCandidate>;
  commitCandidateApproval(workspaceId: string, contentItemId: string, candidateId: string, result: { item: ContentItem; approval: Approval; event: AuditEvent }): Promise<InstagramCollaboratorCandidate>;
  createPollFromStoredProof(workspaceId: string, contentItemId: string, proofId: string, options: { nextAttemptAt: string; expiresAt: string; maxAttempts: number }): Promise<InstagramCollaboratorPoll | null>;
  recoverMissingPolls(options: { nextAttemptAt: string; expiresAt: string; maxAttempts: number; limit: number }): Promise<number>;
  claimDuePolls(owner: string, now: string, limit: number, leaseSeconds: number): Promise<InstagramCollaboratorPoll[]>;
  recordPollResult(poll: InstagramCollaboratorPoll, result: { snapshots: CurrentCollaboratorStatusSnapshot[]; providerReadComplete: boolean; trackingComplete: boolean; availability: string; capturedAt: string; rawResponseSha256?: string | undefined; retryAt?: string | undefined; errorSummary?: string | undefined }): Promise<void>;
  getStatus(workspaceId: string, contentItemId: string, proofId: string): Promise<InstagramCollaboratorStatusView>;
}

export interface InstagramCollaboratorCapabilityView {
  accountId: string;
  publishingUsername: string;
  capability: InstagramCollaboratorCapability;
}
