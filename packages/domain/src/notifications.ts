import type { NotificationKind, NotificationSeverity, WorkspaceNotification } from "./types.js";

export function createNotification(input: {
  workspaceId: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  dedupeKey: string;
  contentItemId?: string | undefined;
  targetId?: string | undefined;
  monitorId?: string | undefined;
  accountId?: string | undefined;
  actionUrl?: string | undefined;
  audience?: "workspace" | "operators" | undefined;
  now?: string;
}): WorkspaceNotification {
  const title = input.title.trim().slice(0, 180);
  const body = input.body.trim().slice(0, 2000);
  const dedupeKey = input.dedupeKey.trim().slice(0, 300);
  if (!input.workspaceId.trim()) throw new Error("Notification workspace is required.");
  if (!title || !body || !dedupeKey) throw new Error("Notification title, body, and dedupe key are required.");
  return {
    id: `notification_${crypto.randomUUID()}`,
    workspaceId: input.workspaceId,
    kind: input.kind,
    severity: input.severity,
    title,
    body,
    dedupeKey,
    ...(input.contentItemId ? { contentItemId: input.contentItemId } : {}),
    ...(input.targetId ? { targetId: input.targetId } : {}),
    ...(input.monitorId ? { monitorId: input.monitorId } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.actionUrl ? { actionUrl: input.actionUrl } : {}),
    audience: input.audience ?? "workspace",
    createdAt: input.now ?? new Date().toISOString(),
  };
}
