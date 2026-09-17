create table audio_profiles (
 id text primary key, workspace_id text not null, brand_id text not null, version integer not null,
 payload jsonb not null, credential jsonb not null,
 unique(workspace_id,id),
 foreign key(workspace_id,brand_id) references brands(workspace_id,id),
 check(version > 0),
 check(credential->>'algorithm' = 'aes-256-gcm' and credential ? 'ciphertext')
);
create index audio_profiles_brand on audio_profiles(workspace_id,brand_id);
create table audio_runs (
 id text primary key, workspace_id text not null, brand_id text not null, profile_id text not null,
 idempotency_hash text not null, created_at timestamptz not null, status text not null,
 payload jsonb not null, unique(workspace_id,idempotency_hash),
 foreign key(workspace_id,profile_id) references audio_profiles(workspace_id,id),
 foreign key(workspace_id,brand_id) references brands(workspace_id,id),
 check(status in ('generating','ready','failed'))
);
create index audio_runs_budget on audio_runs(workspace_id,profile_id,created_at);
create index audio_runs_brand on audio_runs(workspace_id,brand_id,created_at desc);
