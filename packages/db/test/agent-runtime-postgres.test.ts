import type { AgentRunLedgerEntry, AgentRuntimeCredential, AuditEvent } from "@originpost/domain";
import { createAgentRuntimeProfile } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAgentRuntimeRepository } from "../src/postgres-agent-runtime-repository.js";

const databaseUrl=process.env.TEST_DATABASE_URL;const suite=databaseUrl?describe:describe.skip;
const workspaceId="workspace-agent-runtime-integration";const brandId="brand-agent-runtime-integration";const ownerId="owner-agent-runtime-integration";const at="2026-09-01T08:00:00.000Z";
const actor={id:ownerId,name:"Runtime owner",role:"owner" as const,actorType:"human" as const};
const audit=(id:string):AuditEvent=>({id,workspaceId,actorId:ownerId,actorType:"human",action:id,detail:{},createdAt:at});

suite("Postgres workspace AI runtime repository",()=>{
  const sql=postgres(databaseUrl!);const repository=new PostgresAgentRuntimeRepository(sql);
  beforeAll(async()=>{await sql`insert into workspaces(id,name,slug,created_at) values(${workspaceId},'Agent runtime integration','agent-runtime-integration',${at}) on conflict(id) do nothing`;await sql`insert into auth_users(id,email,display_name,password_hash,status,created_at,updated_at) values(${ownerId},'agent-runtime@example.invalid','Runtime owner','disabled','active',${at},${at}) on conflict(id) do nothing`;await sql`insert into brands(id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values(${brandId},${workspaceId},'Runtime brand','runtime','English','UTC','active',${ownerId},${at},${at}) on conflict(id) do nothing`;});
  afterAll(async()=>{await sql`delete from agent_run_ledger where workspace_id=${workspaceId}`;await sql`delete from agent_runtime_assignments where workspace_id=${workspaceId}`;await sql`delete from agent_runtime_profiles where workspace_id=${workspaceId}`;await sql`delete from workspaces where id=${workspaceId}`;await sql`delete from auth_users where id=${ownerId}`;await sql.end();});
  it("round-trips encrypted execution context, healthy assignment, usage, and explicit unassignment",async()=>{
    const created=createAgentRuntimeProfile({id:"runtime-postgres",workspaceId,name:"Editorial runtime",preset:"custom",baseUrl:"https://models.example.invalid/v1",textModel:"editorial-model",visionModel:"visual-model",credentialConfigured:true,actor,now:at});
    const credential:AgentRuntimeCredential={keyVersion:"v1",algorithm:"aes-256-gcm",iv:"aXY=",authTag:"dGFn",ciphertext:"Y2lwaGVydGV4dA=="};
    await repository.createProfile(created.profile,credential,created.event);expect(await repository.listProfiles(workspaceId)).toEqual([expect.not.objectContaining({credential:expect.anything()})]);
    const healthy=await repository.updateHealth(workspaceId,created.profile.id,1,{status:"healthy",checkedAt:"2026-09-01T08:01:00.000Z"},audit("runtime-health"));expect(healthy).toMatchObject({status:"healthy",version:2});
    await repository.assign({workspaceId,brandId,profileId:created.profile.id,assignedBy:ownerId,assignedAt:"2026-09-01T08:02:00.000Z"},audit("runtime-assign"));expect(await repository.getExecutionContext(workspaceId,brandId)).toMatchObject({profile:{id:created.profile.id,status:"healthy",visionModel:"visual-model"},credential});
    const run:AgentRunLedgerEntry={id:"runtime-run-postgres",workspaceId,brandId,profileId:created.profile.id,feature:"draft_assist",model:"editorial-model",status:"succeeded",requestSha256:"a".repeat(64),responseSha256:"b".repeat(64),inputTokens:12,outputTokens:7,latencyMs:42,createdBy:ownerId,createdAt:"2026-09-01T08:03:00.000Z"};await repository.recordRun(run,audit("runtime-run"));expect(await repository.listRuns(workspaceId,created.profile.id)).toEqual([run]);const visualRun:AgentRunLedgerEntry={...run,id:"vision-run-postgres",feature:"image_review",model:"visual-model",createdAt:"2026-09-01T08:04:00.000Z"};await repository.recordRun(visualRun,audit("vision-run"));expect((await repository.listRuns(workspaceId,created.profile.id))[0]).toEqual(visualRun);
    expect(await repository.unassign(workspaceId,brandId,audit("runtime-unassign"))).toBe(true);expect(await repository.getAssignment(workspaceId,brandId)).toBeNull();
  });
});
