import type { EncryptedCredential, OAuthConnectionState, OAuthRepository } from "@originpost/domain";
import type { Sql } from "postgres";

type StateRow = { id: string; workspace_id: string; brand_id: string; platform: OAuthConnectionState["platform"]; actor_id: string; state_hash: string; return_url: string; created_at: Date; expires_at: Date; consumed_at: Date | null };
type CredentialRow = { id: string; workspace_id: string; purpose: EncryptedCredential["purpose"]; key_version: string; algorithm: "aes-256-gcm"; iv: string; auth_tag: string; ciphertext: string; created_at: Date; updated_at: Date };

function state(row: StateRow): OAuthConnectionState {
  return { id: row.id, workspaceId: row.workspace_id, brandId: row.brand_id, platform: row.platform, actorId: row.actor_id, stateHash: row.state_hash, returnUrl: row.return_url, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), ...(row.consumed_at ? { consumedAt: row.consumed_at.toISOString() } : {}) };
}

function credential(row: CredentialRow): EncryptedCredential {
  return { id: row.id, workspaceId: row.workspace_id, purpose: row.purpose, keyVersion: row.key_version, algorithm: row.algorithm, iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

export class PostgresOAuthRepository implements OAuthRepository {
  constructor(private readonly sql: Sql) {}

  async createState(value: OAuthConnectionState): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`delete from encrypted_credentials where purpose = 'provider-discovery' and created_at < ${new Date(new Date(value.createdAt).getTime() - 60 * 60_000).toISOString()}`;
      await sql`delete from oauth_connection_states where expires_at < ${value.createdAt} or (consumed_at is not null and consumed_at < ${new Date(new Date(value.createdAt).getTime() - 86_400_000).toISOString()})`;
      await sql`insert into oauth_connection_states (id, workspace_id, brand_id, platform, actor_id, state_hash, return_url, created_at, expires_at, consumed_at) values (${value.id}, ${value.workspaceId}, ${value.brandId}, ${value.platform}, ${value.actorId}, ${value.stateHash}, ${value.returnUrl}, ${value.createdAt}, ${value.expiresAt}, ${value.consumedAt ?? null})`;
    });
  }

  async consumeState(stateHash: string, platform: OAuthConnectionState["platform"], now: string): Promise<OAuthConnectionState | null> {
    const rows = await this.sql<StateRow[]>`update oauth_connection_states set consumed_at = ${now} where id = (select id from oauth_connection_states where state_hash = ${stateHash} and platform = ${platform} and consumed_at is null and expires_at > ${now} for update skip locked limit 1) returning *`;
    return rows[0] ? state(rows[0]) : null;
  }

  async saveCredential(value: EncryptedCredential): Promise<void> {
    await this.sql`insert into encrypted_credentials (id, workspace_id, purpose, key_version, algorithm, iv, auth_tag, ciphertext, created_at, updated_at) values (${value.id}, ${value.workspaceId}, ${value.purpose}, ${value.keyVersion}, ${value.algorithm}, ${value.iv}, ${value.authTag}, ${value.ciphertext}, ${value.createdAt}, ${value.updatedAt}) on conflict (id) do update set key_version = excluded.key_version, algorithm = excluded.algorithm, iv = excluded.iv, auth_tag = excluded.auth_tag, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at where encrypted_credentials.workspace_id = excluded.workspace_id`;
  }

  async getCredential(workspaceId: string, id: string): Promise<EncryptedCredential | null> {
    const rows = await this.sql<CredentialRow[]>`select * from encrypted_credentials where workspace_id = ${workspaceId} and id = ${id} limit 1`;
    return rows[0] ? credential(rows[0]) : null;
  }

  async hasCredential(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.sql<{ found: boolean }[]>`select exists(select 1 from encrypted_credentials where workspace_id = ${workspaceId} and id = ${id}) as found`;
    return rows[0]?.found ?? false;
  }

  async consumeCredential(workspaceId: string, id: string, purpose: EncryptedCredential["purpose"]): Promise<EncryptedCredential | null> {
    const rows = await this.sql<CredentialRow[]>`delete from encrypted_credentials where workspace_id = ${workspaceId} and id = ${id} and purpose = ${purpose} returning *`;
    return rows[0] ? credential(rows[0]) : null;
  }

  async deleteCredential(workspaceId: string, id: string): Promise<void> { await this.sql`delete from encrypted_credentials where workspace_id = ${workspaceId} and id = ${id}`; }
}
