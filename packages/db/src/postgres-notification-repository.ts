import type { NotificationKind, NotificationRepository, NotificationSeverity, WorkspaceNotification } from "@originpost/domain";
import type { Sql } from "postgres";

type NotificationRow = {
  id: string;
  workspace_id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  content_item_id: string | null;
  target_id: string | null;
  monitor_id: string | null;
  account_id: string | null;
  action_url: string | null;
  dedupe_key: string;
  audience: "workspace" | "operators";
  created_at: Date;
  read_at: Date | null;
  read_by: string | null;
};

function mapRow(row: NotificationRow): WorkspaceNotification {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    dedupeKey: row.dedupe_key,
    audience: row.audience,
    createdAt: row.created_at.toISOString(),
    ...(row.content_item_id ? { contentItemId: row.content_item_id } : {}),
    ...(row.target_id ? { targetId: row.target_id } : {}),
    ...(row.monitor_id ? { monitorId: row.monitor_id } : {}),
    ...(row.account_id ? { accountId: row.account_id } : {}),
    ...(row.action_url ? { actionUrl: row.action_url } : {}),
    ...(row.read_at ? { readAt: row.read_at.toISOString() } : {}),
    ...(row.read_by ? { readBy: row.read_by } : {}),
  };
}

export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string, options: { unreadOnly?: boolean; limit?: number; includeOperatorAlerts?: boolean } = {}): Promise<WorkspaceNotification[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
    const rows = options.unreadOnly
      ? await this.sql<NotificationRow[]>`select * from workspace_notifications where workspace_id = ${workspaceId} and (${options.includeOperatorAlerts === true} or audience = 'workspace') and read_at is null order by created_at desc limit ${limit}`
      : await this.sql<NotificationRow[]>`select * from workspace_notifications where workspace_id = ${workspaceId} and (${options.includeOperatorAlerts === true} or audience = 'workspace') order by created_at desc limit ${limit}`;
    return rows.map(mapRow);
  }

  async countUnread(workspaceId: string, options: { includeOperatorAlerts?: boolean } = {}): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`select count(*)::int as count from workspace_notifications where workspace_id = ${workspaceId} and (${options.includeOperatorAlerts === true} or audience = 'workspace') and read_at is null`;
    return rows[0]?.count ?? 0;
  }

  async create(notification: WorkspaceNotification): Promise<WorkspaceNotification> {
    const rows = await this.sql<NotificationRow[]>`
      insert into workspace_notifications (
        id, workspace_id, kind, severity, title, body, content_item_id, target_id,
        monitor_id, account_id, action_url, dedupe_key, audience, created_at, read_at, read_by
      ) values (
        ${notification.id}, ${notification.workspaceId}, ${notification.kind}, ${notification.severity},
        ${notification.title}, ${notification.body}, ${notification.contentItemId ?? null}, ${notification.targetId ?? null},
        ${notification.monitorId ?? null}, ${notification.accountId ?? null}, ${notification.actionUrl ?? null},
        ${notification.dedupeKey}, ${notification.audience ?? "workspace"}, ${notification.createdAt}, ${notification.readAt ?? null}, ${notification.readBy ?? null}
      )
      on conflict (workspace_id, dedupe_key) do update set dedupe_key = excluded.dedupe_key
      returning *
    `;
    return mapRow(rows[0]!);
  }

  async markRead(workspaceId: string, id: string, actorId: string, readAt: string, options: { includeOperatorAlerts?: boolean } = {}): Promise<WorkspaceNotification | null> {
    const rows = await this.sql<NotificationRow[]>`
      update workspace_notifications set read_at = coalesce(read_at, ${readAt}), read_by = coalesce(read_by, ${actorId})
      where workspace_id = ${workspaceId} and id = ${id} and (${options.includeOperatorAlerts === true} or audience = 'workspace')
      returning *
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async markAllRead(workspaceId: string, actorId: string, readAt: string, options: { includeOperatorAlerts?: boolean } = {}): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      update workspace_notifications set read_at = ${readAt}, read_by = ${actorId}
      where workspace_id = ${workspaceId} and (${options.includeOperatorAlerts === true} or audience = 'workspace') and read_at is null
      returning id
    `;
    return rows.length;
  }
}
