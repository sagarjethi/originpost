-- Fail closed if an earlier deployment wrote a fork, then prevent two proofs
-- from claiming the same predecessor for one provider object.
do $$
begin
  if exists (
    select 1
    from removal_proofs
    group by workspace_id, account_id, external_post_id, previous_proof_sha256
    having count(*) > 1
  ) then
    raise exception 'cannot install removal proof fork guard: existing chain fork detected'
      using errcode = '23505';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'removal_proofs_unique_predecessor'
      and conrelid = 'removal_proofs'::regclass
  ) then
    alter table removal_proofs
      add constraint removal_proofs_unique_predecessor
      unique (workspace_id, account_id, external_post_id, previous_proof_sha256);
  end if;
end $$;
