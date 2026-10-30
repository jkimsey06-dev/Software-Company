-- RLS and constraint tests for public.inbound_messages.

\set ON_ERROR_STOP on
\set QUIET on

reset role;
reset request.jwt.claims;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a7', 'owner-g@example.com'),
  ('00000000-0000-0000-0000-0000000000b7', 'owner-h@example.com');

insert into public.tenants (id, slug, name) values
  ('10000000-0000-0000-0000-0000000000a7', 'tenant-g', 'Tenant G'),
  ('10000000-0000-0000-0000-0000000000b7', 'tenant-h', 'Tenant H');

insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-0000000000a7', '00000000-0000-0000-0000-0000000000a7', 'owner'),
  ('10000000-0000-0000-0000-0000000000b7', '00000000-0000-0000-0000-0000000000b7', 'owner');

insert into public.leads (id, tenant_id, phone, source) values
  ('20000000-0000-0000-0000-0000000000a7', '10000000-0000-0000-0000-0000000000a7', '+14235551001', 'missed_call'),
  ('20000000-0000-0000-0000-0000000000b7', '10000000-0000-0000-0000-0000000000b7', '+14235551101', 'missed_call');

set role service_role;

insert into public.inbound_messages (tenant_id, message_sid, from_phone, to_phone, body, lead_id) values
  ('10000000-0000-0000-0000-0000000000a7', 'SM' || repeat('a', 32), '+14235551001', '+14235551000', 'Hi, my AC is out',
   '20000000-0000-0000-0000-0000000000a7'),
  ('10000000-0000-0000-0000-0000000000b7', 'SM' || repeat('b', 32), '+14235551101', '+14235551100', 'STOP', null);

do $$
begin
  begin
    insert into public.inbound_messages (tenant_id, message_sid, from_phone, to_phone, body)
    values ('10000000-0000-0000-0000-0000000000a7', 'SM' || repeat('a', 32), '+14235551001', '+14235551000', 'again');
    raise exception 'FAIL: duplicate MessageSid accepted';
  exception when unique_violation then
    null;
  end;
  begin
    insert into public.inbound_messages (tenant_id, message_sid, from_phone, to_phone, body, lead_id)
    values ('10000000-0000-0000-0000-0000000000a7', 'SM' || repeat('c', 32), '+14235551001', '+14235551000', 'x',
            '20000000-0000-0000-0000-0000000000b7');
    raise exception 'FAIL: inbound message linked to another tenant''s lead';
  exception when foreign_key_violation then
    null;
  end;
  begin
    insert into public.inbound_messages (tenant_id, message_sid, from_phone, to_phone, body)
    values ('10000000-0000-0000-0000-0000000000a7', 'not-a-sid', '+14235551001', '+14235551000', 'x');
    raise exception 'FAIL: malformed MessageSid accepted';
  exception when check_violation then
    null;
  end;
  begin
    insert into public.inbound_messages (tenant_id, message_sid, from_phone, to_phone, body)
    values ('10000000-0000-0000-0000-0000000000a7', 'SM' || repeat('d', 32), '+14235551001', '+14235551000', repeat('x', 5001));
    raise exception 'FAIL: oversized body accepted';
  exception when check_violation then
    null;
  end;
  raise notice 'ok - inbound messages are unique per MessageSid and tied to their own tenant';
end;
$$;

-- record_inbound_sms: opt-out ordering ------------------------------------------------

do $$
declare
  t uuid := '10000000-0000-0000-0000-0000000000b7';
  p text := '+14235551199';
  is_opted_out boolean;
begin
  -- START (s1), then STOP (s2), then a redelivery of the old START (s1).
  perform public.record_inbound_sms(t, 'SM' || repeat('1', 32), p, '+14235551100', 'START', 'start', null);
  perform public.record_inbound_sms(t, 'SM' || repeat('2', 32), p, '+14235551100', 'STOP', 'stop', null);
  if public.record_inbound_sms(t, 'SM' || repeat('1', 32), p, '+14235551100', 'START', 'start', null) then
    raise exception 'FAIL: redelivered message reported as new';
  end if;
  select exists (select 1 from public.opt_outs where tenant_id = t and phone = p) into is_opted_out;
  if not is_opted_out then raise exception 'FAIL: a replayed START undid a later STOP'; end if;

  -- A replayed old STOP doesn't undo a later START either.
  perform public.record_inbound_sms(t, 'SM' || repeat('6', 32), p, '+14235551100', 'START', 'start', null);
  perform public.record_inbound_sms(t, 'SM' || repeat('2', 32), p, '+14235551100', 'STOP', 'stop', null);
  if exists (select 1 from public.opt_outs where tenant_id = t and phone = p) then
    raise exception 'FAIL: a replayed STOP undid a later START';
  end if;
  perform public.record_inbound_sms(t, 'SM' || repeat('7', 32), p, '+14235551100', 'STOP', 'stop', null);

  -- A new START clears the customer's own opt-out...
  perform public.record_inbound_sms(t, 'SM' || repeat('3', 32), p, '+14235551100', 'START', 'start', null);
  if exists (select 1 from public.opt_outs where tenant_id = t and phone = p) then
    raise exception 'FAIL: new START did not clear the opt-out';
  end if;

  -- ...but never one the owner entered by hand.
  insert into public.opt_outs (tenant_id, phone, source) values (t, p, 'manual');
  perform public.record_inbound_sms(t, 'SM' || repeat('4', 32), p, '+14235551100', 'START', 'start', null);
  if not exists (select 1 from public.opt_outs where tenant_id = t and phone = p and source = 'manual') then
    raise exception 'FAIL: START removed a manual opt-out';
  end if;

  -- Cross-tenant: tenant G's START doesn't touch tenant H's opt-outs.
  perform public.record_inbound_sms('10000000-0000-0000-0000-0000000000a7', 'SM' || repeat('5', 32), p, '+14235551000', 'START', 'start', null);
  if not exists (select 1 from public.opt_outs where tenant_id = t and phone = p) then
    raise exception 'FAIL: another tenant''s START removed this opt-out';
  end if;
  delete from public.inbound_messages where message_sid = 'SM' || repeat('5', 32);
  raise notice 'ok - replayed keywords never undo later ones; START never clears manual or other tenants'' opt-outs';
end;
$$;

set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a7","role":"authenticated"}';

do $$
declare
  stmt text;
begin
  if (select count(*) from public.inbound_messages) <> 1
     or exists (select 1 from public.inbound_messages where tenant_id <> '10000000-0000-0000-0000-0000000000a7') then
    raise exception 'FAIL: owner G should see only tenant G messages';
  end if;
  foreach stmt in array array[
    'insert into public.inbound_messages (tenant_id, message_sid, from_phone, to_phone, body) values (''10000000-0000-0000-0000-0000000000a7'', ''SM' || repeat('e', 32) || ''', ''+14235551001'', ''+14235551000'', ''x'')',
    'update public.inbound_messages set body = ''edited''',
    'delete from public.inbound_messages',
    'select public.record_inbound_sms(''10000000-0000-0000-0000-0000000000a7'', ''SM' || repeat('f', 32) || ''', ''+14235551001'', ''+14235551000'', ''START'', ''start'', null)'
  ] loop
    begin
      execute stmt;
      raise exception 'FAIL: user was allowed: %', stmt;
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  raise notice 'ok - owner G reads only tenant G messages and cannot write';
end;
$$;

reset request.jwt.claims;
set role anon;

do $$
begin
  begin
    perform 1 from public.inbound_messages;
    raise exception 'FAIL: anon can read inbound messages';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok - anon cannot read inbound messages';
end;
$$;

reset role;

\echo 'All inbound SMS RLS tests passed.'
