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

  -- Leases: exactly one holder until released or expired.
  if not public.acquire_conversation_lease(next_id, 60) then raise exception 'FAIL: first lease refused'; end if;
  if public.acquire_conversation_lease(next_id, 60) then raise exception 'FAIL: lease taken twice'; end if;
  update public.conversations set lease_until = now() - interval '1 second' where id = next_id;
  if not public.acquire_conversation_lease(next_id, 60) then raise exception 'FAIL: expired lease not retaken'; end if;

  -- One turn per inbound message.
  insert into public.conversation_turns (tenant_id, conversation_id, inbound_message_sid, action)
  values (t, next_id, 'SM' || repeat('1', 32), 'ai_reply');
  begin
    insert into public.conversation_turns (tenant_id, conversation_id, inbound_message_sid, action)
    values (t, next_id, 'SM' || repeat('1', 32), 'ai_reply');
    raise exception 'FAIL: two turns for one inbound message';
  exception when unique_violation then
    null;
  end;

  -- A turn can't point at another tenant's conversation; a conversation can't
  -- point at another tenant's lead.
  begin
    insert into public.conversation_turns (tenant_id, conversation_id, inbound_message_sid, action)
    values ('10000000-0000-0000-0000-0000000000d9', next_id, 'SM' || repeat('2', 32), 'ai_reply');
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
    values (t, next_id, 'SM' || repeat('3', 32), 'whatever');
    raise exception 'FAIL: unknown action accepted';
  exception when check_violation then
    null;
  end;
  raise notice 'ok - one conversation per phone, one lease holder, one turn per message, tenant-bound';
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
    'select public.acquire_conversation_lease(gen_random_uuid(), 60)'
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
