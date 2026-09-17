import { assertAudioDraftBudget, assertAudioDraftReplay, type AudioDraftRun, assertAudioBudget, assertAudioReplay, DomainError, type AudioProfile, type AudioRepository, type AudioRun, type AuditEvent, type EncryptedCredential } from '@originpost/domain';
import type { Sql, TransactionSql } from 'postgres';
async function audit(sql: Sql | TransactionSql, e: AuditEvent) {
  await sql`insert into audit_events(id,workspace_id,content_item_id,actor_id,actor_type,action,detail,created_at) values(${e.id},${e.workspaceId},${e.contentItemId ?? null},${e.actorId},${e.actorType},${e.action},${sql.json(e.detail as never)},${e.createdAt})`;
}
export class PostgresAudioRepository implements AudioRepository {
  constructor(private readonly sql: Sql) {}
  async reserveDraft(run: AudioDraftRun, event: AuditEvent) {
    return this.sql.begin(async sql => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${run.workspaceId + ':audio-draft:' + run.idempotencyHash},0))`;
      const previous = (await sql<{ payload: AudioDraftRun }[]>`select payload from audio_draft_runs where workspace_id=${run.workspaceId} and idempotency_hash=${run.idempotencyHash}`)[0]?.payload;
      if (previous) { assertAudioDraftReplay(previous,run); return { run: previous, created: false }; }
      const profile = (await sql<{ payload: AudioProfile }[]>`select payload from audio_profiles where workspace_id=${run.workspaceId} and id=${run.profileId} for update`)[0]?.payload;
      const start = run.createdAt.slice(0,10) + 'T00:00:00.000Z';
      const used = (await sql<{ count: number }[]>`select count(*)::int as count from audio_draft_runs where workspace_id=${run.workspaceId} and profile_id=${run.profileId} and created_at>=${start}::timestamptz and created_at<${start}::timestamptz + interval '1 day'`)[0]?.count ?? 0;
      assertAudioDraftBudget(profile,run,used);
      await sql`insert into audio_draft_runs(id,workspace_id,brand_id,profile_id,idempotency_hash,created_at,status,payload) values(${run.id},${run.workspaceId},${run.brandId},${run.profileId},${run.idempotencyHash},${run.createdAt},${run.status},${sql.json(run as never)})`;
      await audit(sql,event); return { run, created: true };
    });
  }
  async finishDraft(run: AudioDraftRun,event: AuditEvent) { await this.sql.begin(async sql => { const rows = await sql`update audio_draft_runs set status=${run.status},payload=${sql.json(run as never)} where workspace_id=${run.workspaceId} and id=${run.id} and status='generating' returning id`; if(rows.length) await audit(sql,event); }); }
  async listProfiles(w: string, b: string) { return (await this.sql<{ payload: AudioProfile }[]>`select payload from audio_profiles where workspace_id=${w} and brand_id=${b} order by id`).map(x => x.payload); }
  async getProfile(w: string, id: string) { const row = (await this.sql<{ payload: AudioProfile; credential: EncryptedCredential }[]>`select payload,credential from audio_profiles where workspace_id=${w} and id=${id}`)[0]; return row ? { profile: row.payload, credential: row.credential } : null; }
  async saveProfile(p: AudioProfile, credential: EncryptedCredential, version: number, event: AuditEvent) {
    await this.sql.begin(async sql => {
      const rows = version === 0
        ? await sql`insert into audio_profiles(id,workspace_id,brand_id,version,payload,credential) values(${p.id},${p.workspaceId},${p.brandId},${p.version},${sql.json(p as never)},${sql.json(credential as never)}) on conflict do nothing returning id`
        : await sql`update audio_profiles set version=${p.version},payload=${sql.json(p as never)},credential=${sql.json(credential as never)} where workspace_id=${p.workspaceId} and id=${p.id} and version=${version} returning id`;
      if (!rows.length) throw new DomainError('Audio settings changed. Refresh.', 'version_conflict', 409);
      await audit(sql,event);
    });
  }
  async reserve(run: AudioRun, event: AuditEvent) {
    return this.sql.begin(async sql => {
      // Lock both request identity and profile: replay and daily budgets remain atomic across API processes.
      await sql`select pg_advisory_xact_lock(hashtextextended(${run.workspaceId + ':' + run.idempotencyHash},0))`;
      const previous = (await sql<{ payload: AudioRun }[]>`select payload from audio_runs where workspace_id=${run.workspaceId} and idempotency_hash=${run.idempotencyHash}`)[0]?.payload;
      if (previous) { assertAudioReplay(previous,run); return { run: previous, created: false }; }
      const profile = (await sql<{ payload: AudioProfile }[]>`select payload from audio_profiles where workspace_id=${run.workspaceId} and id=${run.profileId} for update`)[0]?.payload;
      const start = run.createdAt.slice(0,10) + 'T00:00:00.000Z';
      const used = (await sql<{ count: number }[]>`select count(*)::int as count from audio_runs where workspace_id=${run.workspaceId} and profile_id=${run.profileId} and created_at>=${start}::timestamptz and created_at<${start}::timestamptz + interval '1 day'`)[0]?.count ?? 0;
      assertAudioBudget(profile,run,used);
      await sql`insert into audio_runs(id,workspace_id,brand_id,profile_id,idempotency_hash,created_at,status,payload) values(${run.id},${run.workspaceId},${run.brandId},${run.profileId},${run.idempotencyHash},${run.createdAt},${run.status},${sql.json(run as never)})`;
      await audit(sql,event); return { run, created: true };
    });
  }
  async finish(run: AudioRun,event: AuditEvent) { await this.sql.begin(async sql => { const rows = await sql`update audio_runs set status=${run.status},payload=${sql.json(run as never)} where workspace_id=${run.workspaceId} and id=${run.id} and status='generating' returning id`; if(rows.length) await audit(sql,event); }); }
  async listRuns(w: string,b: string) { return (await this.sql<{ payload: AudioRun }[]>`select payload from audio_runs where workspace_id=${w} and brand_id=${b} order by created_at desc,id desc limit 100`).map(x => x.payload); }
}
