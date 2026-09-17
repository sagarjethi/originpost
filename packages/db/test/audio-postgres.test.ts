import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import type { AudioDraftRun,AudioProfile,AudioRun,AuditEvent,EncryptedCredential } from '@originpost/domain';
import { PostgresAudioRepository } from '../src/postgres-audio-repository.js';
const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('durable audio concurrency',()=>{
 const sql=postgres(url!),repo=new PostgresAudioRepository(sql),w=`audio-test-${randomUUID()}`,b=`brand-${w}`,at=new Date().toISOString();
 const event=():AuditEvent=>({id:randomUUID(),workspaceId:w,actorId:'test-owner',actorType:'human',action:'audio.test',detail:{},createdAt:at});
 const profile:AudioProfile={id:`profile-${w}`,workspaceId:w,brandId:b,version:1,provider:'elevenlabs',name:'Test',model:'eleven_v3',enabled:true,allowedRoles:['owner'],maxCharacters:1500,dailyRequests:1,dailyDraftRequests:1,skills:[],credentialConfigured:true,createdBy:'test-owner',updatedAt:at};
 const credential:EncryptedCredential={id:'fixture',workspaceId:w,purpose:'provider-token',keyVersion:'v1',algorithm:'aes-256-gcm',iv:'fixture',authTag:'fixture',ciphertext:'encrypted-fixture',createdAt:at,updatedAt:at};
 const run=(key:string):AudioRun=>({id:randomUUID(),workspaceId:w,brandId:b,profileId:profile.id,profileVersion:1,requestHash:key,idempotencyHash:key,textHash:'hash-only',characterCount:10,model:'eleven_v3',voiceId:'v',language:'gu',status:'generating',createdBy:'test-owner',createdAt:at});
 beforeAll(async()=>{await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${w},'Audio test',${w},${at},${at})`;await sql`insert into brands(id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values(${b},${w},'Audio test',${b},'Gujarati','UTC','active','test-owner',${at},${at})`;await repo.saveProfile(profile,credential,0,event());});
 afterAll(async()=>{await sql`delete from audio_draft_runs where workspace_id=${w}`;await sql`delete from audio_runs where workspace_id=${w}`;await sql`delete from audio_profiles where workspace_id=${w}`;await sql`delete from audit_events where workspace_id=${w}`;await sql`delete from brands where workspace_id=${w}`;await sql`delete from workspaces where id=${w}`;await sql.end();});
 it('reserves exactly one paid request across concurrent callers and rejects further budget use',async()=>{
   const input=run('same-request');const results=await Promise.all(Array.from({length:8},()=>repo.reserve({...input,id:randomUUID()},event())));
   expect(results.filter(x=>x.created)).toHaveLength(1);expect(new Set(results.map(x=>x.run.id)).size).toBe(1);
   await expect(repo.reserve(run('next-request'),event())).rejects.toThrow('daily request limit');
   await repo.finish({...results[0]!.run,status:'ready',mediaId:'media-fixture'},event());
   expect((await repo.listRuns(w,b))[0]?.status).toBe('ready');
   await expect(repo.saveProfile({...profile,version:2},credential,0,event())).rejects.toThrow('changed');
   expect(await repo.getProfile('another-workspace',profile.id)).toBeNull();
 });
 it('atomically reserves separate script quotas, replays saved text, and rejects changed input',async()=>{
   const input:AudioDraftRun={id:randomUUID(),workspaceId:w,brandId:b,profileId:profile.id,profileVersion:1,contentItemId:'news-fixture',requestHash:'draft-input',idempotencyHash:'draft-key',status:'generating',createdBy:'test-owner',createdAt:at};
   const results=await Promise.all(Array.from({length:8},()=>repo.reserveDraft({...input,id:randomUUID()},event())));
   expect(results.filter(x=>x.created)).toHaveLength(1);expect(new Set(results.map(x=>x.run.id)).size).toBe(1);
   await expect(repo.reserveDraft({...input,idempotencyHash:'another-key'},event())).rejects.toThrow('daily script-draft limit');
   const ready={...results[0]!.run,status:'ready' as const,text:'Reviewed narration',characterCount:18};
   await repo.finishDraft(ready,event());
   expect((await repo.reserveDraft(input,event())).run).toMatchObject({status:'ready',text:ready.text});
   await expect(repo.reserveDraft({...input,requestHash:'changed'},event())).rejects.toThrow('different script draft');
   expect((await repo.listRuns(w,b)).some(r=>r.id===ready.id)).toBe(false);
 });

 it('does not overspend the draft quota when distinct requests race',async()=>{
   const p={...profile,id:`parallel-${w}`,dailyDraftRequests:2};
   await repo.saveProfile(p,credential,0,event());
   const results=await Promise.allSettled(Array.from({length:8},(_,i)=>repo.reserveDraft({id:randomUUID(),workspaceId:w,brandId:b,profileId:p.id,profileVersion:1,contentItemId:'news-fixture',requestHash:`input-${i}`,idempotencyHash:`parallel-${i}`,status:'generating',createdBy:'test-owner',createdAt:at},event())));
   expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
   expect(results.filter(r=>r.status==='rejected')).toHaveLength(6);
 });

});
