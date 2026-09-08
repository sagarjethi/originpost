import type { Sql } from "postgres";

export class PostgresTelegramReceiptRepository {
  constructor(private readonly sql: Sql) {}

  async claim(workspaceId: string, updateId: number, chatId: string, leaseSeconds = 300): Promise<boolean> {
    const leasedUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const rows = await this.sql<{ update_id: string }[]>`
      insert into telegram_update_receipts (workspace_id, update_id, chat_id, status, leased_until)
      values (${workspaceId}, ${updateId}, ${chatId}, 'processing', ${leasedUntil})
      on conflict (workspace_id, update_id) do update set
        chat_id = excluded.chat_id,
        status = 'processing',
        leased_until = excluded.leased_until,
        attempts = telegram_update_receipts.attempts + 1,
        error = null,
        updated_at = now()
      where telegram_update_receipts.status = 'failed'
         or (telegram_update_receipts.status = 'processing' and telegram_update_receipts.leased_until < now())
      returning update_id
    `;
    return rows.length === 1;
  }

  async complete(workspaceId: string, updateId: number): Promise<void> {
    await this.sql`update telegram_update_receipts set status = 'completed', leased_until = now(), error = null, updated_at = now() where workspace_id = ${workspaceId} and update_id = ${updateId}`;
  }

  async fail(workspaceId: string, updateId: number, error: string): Promise<void> {
    await this.sql`update telegram_update_receipts set status = 'failed', leased_until = now(), error = ${error.slice(0, 500)}, updated_at = now() where workspace_id = ${workspaceId} and update_id = ${updateId}`;
  }
}
