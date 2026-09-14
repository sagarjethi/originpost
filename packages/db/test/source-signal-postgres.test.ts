import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSourceSignalRepository } from "../src/postgres-source-signal-repository.js";
import type { SourceSignal } from "@originpost/domain";
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("source signal publication filters in PostgreSQL", () => {
 const sql = postgres(url!,{max:1}); const schema=`signal_test_${randomUUID().replaceAll("-","")}`;
 const repo = new PostgresSourceSignalRepository(sql);
 beforeAll(async () => {
  await sql.unsafe(`create schema ${schema}`); await sql.unsafe(`set search_path to ${schema}`);
  await sql.unsafe('create table workspaces(id text primary key); create table brands(id text primary key); create table monitor_rules(id text primary key); create table monitor_runs(id text primary key); create table content_items(id text, workspace_id text, brand_id text, unique(id,workspace_id,brand_id));');
  await sql.unsafe(await readFile(new URL('../migrations/041_source_signal_inbox.sql',import.meta.url),'utf8'));
  await sql`insert into workspaces values ('w')`; await sql`insert into brands values ('b')`; await sql`insert into monitor_rules values ('m')`; await sql`insert into monitor_runs values ('r')`;
  const base:SourceSignal = {id:'new',workspaceId:'w',brandId:'b',monitorId:'m',monitorRunId:'r',version:1,state:'new',urgency:'low',score:40,rankReasons:[],eventFingerprint:'a'.repeat(64),title:'Latest item',summary:'A current report',sources:[],claims:[],discovery:{query:'news',provider:'public-feeds',model:'rss',toolsUsed:[]},occurrenceCount:1,firstSeenAt:'2026-09-15T00:00:00.000Z',lastSeenAt:'2026-09-15T00:00:00.000Z',publishedAt:'2026-09-14T20:00:00.000Z'};
  await repo.ingest([base,{...base,id:'old',eventFingerprint:'b'.repeat(64),score:100,publishedAt:'2026-08-01T00:00:00.000Z'},{...base,id:'unknown',eventFingerprint:'c'.repeat(64),score:90,publishedAt:undefined}]);
 });
 afterAll(async()=>{await sql.unsafe(`drop schema if exists ${schema} cascade`); await sql.end();});
 it('filters before limiting and puts unknown dates last',async()=>{
  expect((await repo.list({workspaceId:'w',sort:'newest',limit:3})).map(s=>s.id)).toEqual(['new','old','unknown']);
  expect((await repo.list({workspaceId:'w',sort:'newest',publishedAfter:'2026-09-14T00:00:00.000Z',publishedBefore:'2026-09-15T00:00:00.000Z',limit:1})).map(s=>s.id)).toEqual(['new']);
  expect((await repo.list({workspaceId:'w',sort:'priority',limit:1}))[0]?.id).toBe('old');
  expect((await repo.list({workspaceId:'w',sort:'newest',limit:1,offset:1}))[0]?.id).toBe('old');
 });
 it('preserves scope and parameterizes filters',async()=>{
  expect(await repo.list({workspaceId:'other'})).toEqual([]); expect(await repo.list({workspaceId:'w',brandId:'other'})).toEqual([]);
  expect(await repo.list({workspaceId:'w',monitorId:"m' OR TRUE --"})).toEqual([]);
 });
});
