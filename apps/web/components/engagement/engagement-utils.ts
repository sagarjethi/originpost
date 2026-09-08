export type EngagementRole = "owner" | "manager" | "creator" | "viewer";
export type EngagementFilter = "new" | "needs_reply" | "mine" | "resolved";
export type EngagementPlatform = "instagram" | "facebook";
export type EngagementPlatformFilter = "all" | EngagementPlatform;
export type EngagementSubscriptionStatus = "active" | "missing" | "permission_missing" | "unknown";
export type EngagementReconciliationStatus = "current" | "stale" | "syncing" | "failed" | "unknown";

export type EngagementSyncState = "waiting" | "current" | "stale";

export type EngagementProviderInput = {
  platform?: EngagementPlatform | string;
  replySupported?: boolean;
  subscriptionStatus?: EngagementSubscriptionStatus | string;
  reconciliationStatus?: EngagementReconciliationStatus | string;
  externalMediaId?: string;
  externalPostId?: string;
  externalObjectId?: string;
};

export type EngagementProviderState = {
  permission: { tone: "ready" | "waiting" | "attention"; label: string; detail: string };
  subscription: { tone: "ready" | "waiting" | "attention"; label: string; detail: string };
  reconciliation: { tone: "ready" | "waiting" | "attention"; label: string; detail: string };
};

export function engagementCapabilities(role: EngagementRole) {
  return {
    canDraft: role !== "viewer",
    canSend: role === "owner" || role === "manager",
    canManageThread: role === "owner" || role === "manager",
  };
}

export function engagementCanCancelAction(
  role: EngagementRole,
  userId: string,
  action: { requestedBy: string; status: string },
): boolean {
  if (role === "viewer" || action.status === "processing" || action.status === "succeeded" || action.status === "uncertain" || action.status === "cancelled") return false;
  if (role === "creator") return action.requestedBy === userId && (action.status === "draft" || action.status === "pending_approval");
  return role === "owner" || role === "manager";
}

export function engagementNeedsTerminalPoll(actions: Array<{ status: string }>): boolean {
  return actions.some((action) => action.status === "queued" || action.status === "processing");
}

/** Legacy engagement rows predate the platform field and are Instagram rows. */
export function engagementPlatform(value: unknown): EngagementPlatform {
  return value === "facebook" ? "facebook" : "instagram";
}

export function engagementPlatformMatches(value: unknown, filter: EngagementPlatformFilter): boolean {
  return filter === "all" || engagementPlatform(value) === filter;
}

/** Provider object names vary by platform; keep that variation at this display seam. */
export function engagementProviderObjectId(input: EngagementProviderInput): string {
  return [input.externalMediaId, input.externalPostId, input.externalObjectId]
    .find((value) => typeof value === "string" && value.trim())?.trim() ?? "Not reported";
}

export function engagementCanSendReply(input: EngagementProviderInput): boolean {
  const platform = engagementPlatform(input.platform);
  if (input.subscriptionStatus === "permission_missing" || input.subscriptionStatus === "missing") return false;
  if (input.reconciliationStatus === "failed") return false;
  // Facebook is fail-closed until the provider explicitly advertises reply support.
  if (platform === "facebook") return input.replySupported === true;
  return input.replySupported !== false;
}

export function engagementReplyActionCopy(input: EngagementProviderInput): { title: string; detail: string } | null {
  if (engagementCanSendReply(input)) return null;
  const platform = engagementPlatform(input.platform);
  if (input.subscriptionStatus === "permission_missing") {
    return { title: "Action required", detail: `Reconnect the ${platform === "facebook" ? "Facebook Page" : "Instagram"} account with comment reply permission before sending.` };
  }
  if (input.subscriptionStatus === "missing") {
    return { title: "Action required", detail: `Enable the ${platform === "facebook" ? "Facebook Page" : "Instagram"} comment subscription before sending.` };
  }
  if (input.reconciliationStatus === "failed") {
    return { title: "Action required", detail: "Refresh this proof and confirm the live conversation before sending a reply." };
  }
  if (platform === "facebook") {
    return { title: "Action required", detail: "Facebook Page reply sending is not available for this account. Keep the approved draft here, then send it from Facebook." };
  }
  return { title: "Action required", detail: "Reply sending is not available for this account. Keep the approved draft here and send it from the platform." };
}

export function engagementProviderState(input: EngagementProviderInput, lastSyncedAt?: string, now = Date.now()): EngagementProviderState {
  const platform = engagementPlatform(input.platform);
  const platformName = platform === "facebook" ? "Facebook Page" : "Instagram";
  const permission = input.subscriptionStatus === "permission_missing"
    ? { tone: "attention" as const, label: "Permission missing", detail: `Reconnect ${platformName} in Channels.` }
    : input.subscriptionStatus === "active" || input.subscriptionStatus === "missing"
      ? { tone: "ready" as const, label: "Access available", detail: `${platformName} access is available.` }
      : { tone: "waiting" as const, label: "Not reported", detail: "The provider has not reported permission health." };
  const subscription = input.subscriptionStatus === "active"
    ? { tone: "ready" as const, label: "Active", detail: "Comment updates are subscribed." }
    : input.subscriptionStatus === "missing"
      ? { tone: "attention" as const, label: "Missing", detail: "Enable comment updates in Channels." }
      : input.subscriptionStatus === "permission_missing"
        ? { tone: "attention" as const, label: "Blocked", detail: "The subscription needs provider permission." }
        : { tone: "waiting" as const, label: "Unknown", detail: "Subscription health has not been confirmed." };
  const reconciliation = input.reconciliationStatus === "current"
    ? { tone: "ready" as const, label: "Current", detail: "The saved thread matches the latest check." }
    : input.reconciliationStatus === "syncing"
      ? { tone: "waiting" as const, label: "Syncing", detail: "A provider check is in progress." }
      : input.reconciliationStatus === "failed"
        ? { tone: "attention" as const, label: "Failed", detail: "Refresh the proof before replying." }
        : input.reconciliationStatus === "stale"
          ? { tone: "attention" as const, label: "Stale", detail: "Refresh the proof before replying." }
          : engagementSyncState(lastSyncedAt, now) === "current"
            ? { tone: "ready" as const, label: "Current", detail: "The last saved provider check is current." }
            : { tone: "waiting" as const, label: "Unknown", detail: "A current provider check has not been confirmed." };
  return { permission, subscription, reconciliation };
}

export function engagementActionRequiredMessage(body: unknown, input: EngagementProviderInput): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const action = record.action && typeof record.action === "object" ? record.action as Record<string, unknown> : undefined;
  const values = [record.status, record.code, record.error, record.message, action?.status, action?.code]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string");
  if (!values.some((value) => /action[_ -]?required|feature[_ -]?gated|unsupported|not supported|(reply|send).{0,40}unavailable/i.test(value))) return null;
  return engagementReplyActionCopy({ ...input, replySupported: false })?.detail ?? "A person must complete this reply on the platform.";
}

export function engagementSyncState(lastSyncedAt: string | undefined, now = Date.now()): EngagementSyncState {
  if (!lastSyncedAt) return "waiting";
  return now - new Date(lastSyncedAt).getTime() > 20 * 60_000 ? "stale" : "current";
}

export function relativeTime(value: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1_000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function relativePastTime(value: string, now = Date.now()): string {
  const relative = relativeTime(value, now);
  return relative === "Just now" ? "just now" : `${relative} ago`;
}

export function apiMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) return message.filter((part): part is string => typeof part === "string").join(" ") || fallback;
  if (typeof message !== "string" || !message || /^Cannot (GET|POST|PATCH) /i.test(message)) return fallback;
  return message;
}
