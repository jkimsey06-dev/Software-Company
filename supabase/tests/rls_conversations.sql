-- RLS, constraint and function tests for conversations and conversation_turns.

\set ON_ERROR_STOP on
\set QUIET on

reset role;
reset request.jwt.claims;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c9', 'owner-i@example.com'),
  ('00000000-0000-0000-0000-0000000000d9', 'owner-j@example.com');

insert into public.tenants (id, slug, name) values
  ('10000000-0000-0000-0000-0000000000c9', 'tenant-i', 'Tenant I'),
  ('10000000-0000-0000-0000-0000000000d9', 'tenant-j', 'Tenant J');

insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000c9', 'owner'),
  ('10000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000d9', 'owner');

insert into public.leads (id, tenant_id, phone, source) values
  ('20000000-0000-0000-0000-0000000000c9', '10000000-0000-0000-0000-0000000000c9', '+14235552001', 'missed_call'),
  ('20000000-0000-0000-0000-0000000000d9', '10000000-0000-0000-0000-0000000000d9', '+14235552101', 'missed_call');

set role service_role;

do $$
declare
  t uuid := '10000000-0000-0000-0000-0000000000c9';
  first_id uuid;
  again_id uuid;
  next_id uuid;
  tok uuid;
  tok2 uuid;
  n int;
begin
  select id into first_id from public.start_conversation(t, '+14235552001', '20000000-0000-0000-0000-0000000000c9', interval '7 days');
  select id into again_id from public.start_conversation(t, '+14235552001', null, interval '7 days');
  if first_id is null or first_id <> again_id then
    raise exception 'FAIL: a second message started a second conversation';
  end if;

  -- Handed off recently: the same conversation comes back (a person is in charge).
  update public.conversations set status = 'handed_off' where id = first_id;
  select id into again_id from public.start_conversation(t, '+14235552001', null, interval '7 days');
  if again_id <> first_id then raise exception 'FAIL: recent handoff did not stay with the person'; end if;

  -- Handed off longer ago than the reuse window: a new conversation starts.
  -- (now() is fixed within this test's transaction, so a window that ended
  -- before now stands in for "long ago".)
  select id into next_id from public.start_conversation(t, '+14235552001', null, interval '-1 second');
  if next_id = first_id then raise exception 'FAIL: an old handed-off conversation was reused'; end if;

  -- Only one active conversation per phone.
  begin
    insert into public.conversations (tenant_id, customer_phone) values (t, '+14235552001');
    raise exception 'FAIL: two active conversations for one phone';
  exception when unique_violation then
    null;
  end;

  -- Leases: exactly one holder until released or expired; only the holder releases.
  tok := public.acquire_conversation_lease(next_id, 60);
  if tok is null then raise exception 'FAIL: first lease refused'; end if;
  if public.acquire_conversation_lease(next_id, 60) is not null then raise exception 'FAIL: lease taken twice'; end if;
  perform public.release_conversation_lease(next_id, gen_random_uuid());
  if public.acquire_conversation_lease(next_id, 60) is not null then raise exception 'FAIL: a stranger released the lease'; end if;
  perform public.release_conversation_lease(next_id, tok);
  tok := public.acquire_conversation_lease(next_id, 60);
  if tok is null then raise exception 'FAIL: released lease not retaken'; end if;
  update public.conversations set lease_until = now() - interval '1 second' where id = next_id;
  tok2 := public.acquire_conversation_lease(next_id, 60);
  if tok2 is null then raise exception 'FAIL: expired lease not retaken'; end if;
  -- The old holder's late release doesn't free the new holder's lease.
  perform public.release_conversation_lease(next_id, tok);
  if public.acquire_conversation_lease(next_id, 60) is not null then raise exception 'FAIL: stale holder released a new lease'; end if;

  -- One turn per inbound message.
  insert into public.conversation_turns (tenant_id, conversation_id, inbound_message_sid, action)
  values (t, next_id, 'SM' || repeat('c', 31) || '1', 'ask');
  begin
    insert into public.conversation_turns (tenant_id, conversation_id, inbound_message_sid, action)
    values (t, next_id, 'SM' || repeat('c', 31) || '1', 'ask');
    raise exception 'FAIL: two turns for one inbound message';
  exception when unique_violation then
    null;
  end;

  -- A turn can't point at another tenant's conversation; a conversation can't
  -- point at another tenant's lead.
  begin
    insert into public.conversation_turns (tenant_id, conversation_id, inbound_message_sid, action)
    values ('10000000-0000-0000-0000-0000000000d9', next_id, 'SM' || repeat('c', 31) || '2', 'ask');
    raise exception 'FAIL: turn linked to another tenant''s conversation';
  exception when foreign_key_violation then
    null;
  end;
  begin
    insert into public.conversations (tenant_id, customer_phone, lead_id, status)
    values (t, '+14235552009', '20000000-0000-0000-0000-0000000000d9', 'completed');
    raise exception 'FAIL: conversation linked to another tenant''s lead';
  exception when foreign_key_violation then
    null;
  end;
  begin
    insert into public.conversation_turns (tenant_id, conversation_id, inbound_message_sid, action)
    values (t, next_id, 'SM' || repeat('c', 31) || '3', 'whatever');
    raise exception 'FAIL: unknown action accepted';
  exception when check_violation then
    null;
  end;

  -- Unhandled-message sweep: only plain texts with no turn and no owner email.
  insert into public.inbound_messages (tenant_id, message_sid, from_phone, to_phone, body, keyword, created_at) values
    (t, 'SM' || repeat('c', 31) || '1', '+14235552001', '+14235552000', 'handled by AI', null, now() - interval '10 minutes'),
    (t, 'SM' || repeat('c', 31) || '4', '+14235552001', '+14235552000', 'lost mid-turn', null, now() - interval '10 minutes'),
    (t, 'SM' || repeat('c', 31) || '5', '+14235552001', '+14235552000', 'STOP', 'stop', now() - interval '10 minutes'),
    (t, 'SM' || repeat('c', 31) || '6', '+14235552001', '+14235552000', 'forwarded', null, now() - interval '10 minutes'),
    (t, 'SM' || repeat('c', 31) || '7', '+14235552001', '+14235552000', 'just arrived', null, now());
  insert into public.notifications (tenant_id, kind, idempotency_key, recipient_email, subject, body, status)
  values (t, 'new_lead', 'customer-reply:SM' || repeat('c', 31) || '6', 'owner@example.com', 'S', 'B', 'sent');
  select count(*) into n from public.unhandled_inbound_messages(interval '3 minutes', 10)
  where message_sid = 'SM' || repeat('c', 31) || '4';
  if n <> 1 then raise exception 'FAIL: lost message not found by the sweep'; end if;
  select count(*) into n from public.unhandled_inbound_messages(interval '3 minutes', 10);
  if n <> 1 then raise exception 'FAIL: sweep returned handled, keyword, forwarded or too-recent messages (%)', n; end if;
  raise notice 'ok - one conversation per phone, one lease holder, one turn per message, tenant-bound, sweep finds only lost messages';
end;
$$;

-- Tenant J's conversation for the isolation checks.
select 1 from public.start_conversation('10000000-0000-0000-0000-0000000000d9', '+14235552101', null, interval '7 days');

set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c9","role":"authenticated"}';

do $$
declare
  stmt text;
begin
  if exists (select 1 from public.conversations where tenant_id <> '10000000-0000-0000-0000-0000000000c9')
     or exists (select 1 from public.conversation_turns where tenant_id <> '10000000-0000-0000-0000-0000000000c9')
     or not exists (select 1 from public.conversations) then
    raise exception 'FAIL: owner I should see only tenant I conversations';
  end if;
  foreach stmt in array array[
    'update public.conversations set status = ''active''',
    'delete from public.conversation_turns',
    'insert into public.conversations (tenant_id, customer_phone) values (''10000000-0000-0000-0000-0000000000c9'', ''+14235552999'')',
    'select * from public.start_conversation(''10000000-0000-0000-0000-0000000000c9'', ''+14235552998'', null, interval ''1 day'')',
    'select public.acquire_conversation_lease(gen_random_uuid(), 60)',
    'select public.release_conversation_lease(gen_random_uuid(), gen_random_uuid())',
    'select * from public.unhandled_inbound_messages(interval ''1 minute'', 10)'
  ] loop
    begin
      execute stmt;
      raise exception 'FAIL: user was allowed: %', stmt;
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  raise notice 'ok - owner I reads only tenant I conversations and cannot write or call the functions';
end;
$$;

reset request.jwt.claims;
set role anon;

do $$
begin
  begin
    perform 1 from public.conversations;
    raise exception 'FAIL: anon can read conversations';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok - anon cannot read conversations';
end;
$$;

reset role;

\echo 'All conversation RLS tests passed.'
