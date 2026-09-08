-- Permit one-way crypto-shredding of the reversible provider message key while
-- preserving the message's immutable account/conversation lineage.

create or replace function guard_private_message_immutability()
returns trigger language plpgsql as $$
begin
  if row(new.workspace_id, new.brand_id, new.conversation_id, new.account_id, new.platform,
         new.connection_mode, new.provider_message_key_hash,
         new.sender_participant_id, new.direction, new.kind, new.reply_to_message_id, new.is_echo,
         new.provider_created_at, new.first_seen_at, new.source)
     is distinct from
     row(old.workspace_id, old.brand_id, old.conversation_id, old.account_id, old.platform,
         old.connection_mode, old.provider_message_key_hash,
         old.sender_participant_id, old.direction, old.kind, old.reply_to_message_id, old.is_echo,
         old.provider_created_at, old.first_seen_at, old.source) then
    raise exception 'private message identity and original content metadata are immutable';
  end if;
  if new.provider_message_key_envelope is distinct from old.provider_message_key_envelope
     and new.tombstoned_at is null then
    raise exception 'private message provider key may only be crypto-shredded during tombstoning';
  end if;
  if new.body_envelope is distinct from old.body_envelope and new.body_envelope is not null then
    raise exception 'private message body may only be tombstoned';
  end if;
  if new.body_integrity_key is distinct from old.body_integrity_key and new.body_integrity_key is not null then
    raise exception 'private message body hash may only be tombstoned';
  end if;
  if new.attachments_envelope is distinct from old.attachments_envelope
     and new.availability not in ('deleted', 'expired') then
    raise exception 'private message attachments may only be tombstoned';
  end if;
  return new;
end;
$$;

