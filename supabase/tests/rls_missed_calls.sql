-- RLS and constraint tests for tenant_phone_numbers, calls, outbound_messages, opt_outs.
-- Runs after rls_tenant_isolation.sql in the same database; fixtures here are its own.

\set ON_ERROR_STOP on
\set QUIET on

reset role;
reset request.jwt.claims;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner-c@example.com'),
  ('00000000-0000-0000-0000-0000000000d1', 'owner-d@example.com');

insert into public.tenants (id, slug, name) values
  ('10000000-0000-0000-0000-0000000000c1', 'tenant-c', 'Tenant C'),
  ('10000000-0000-0000-0000-0000000000d1', 'tenant-d', 'Tenant D');

insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1', 'owner'),
  ('10000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1', 'owner');

insert into public.leads (id, tenant_id, phone, source) values
  ('20000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c1', '+14235550301', 'missed_call'),
  ('20000000-0000-0000-0000-0000000000d1', '10000000-0000-0000-0000-0000000000d1', '+14235550401', 'missed_call');

-- Server-side writes (as the service role, like the webhook) -----------------

set role service_role;

insert into public.tenant_phone_numbers (phone, tenant_id) values
  ('+14235550300', '10000000-0000-0000-0000-0000000000c1'),
  ('+14235550400', '10000000-0000-0000-0000-0000000000d1');

insert into public.calls (tenant_id, call_sid, from_phone, to_phone, outcome, lead_id) values
  ('10000000-0000-0000-0000-0000000000c1', 'CA' || repeat('c', 32), '+14235550301', '+14235550300', 'missed', '20000000-0000-0000-0000-0000000000c1'),
  ('10000000-0000-0000-0000-0000000000d1', 'CA' || repeat('d', 32), '+14235550401', '+14235550400', 'missed', '20000000-0000-0000-0000-0000000000d1');

insert into public.outbound_messages (tenant_id, idempotency_key, lead_id, to_phone, from_phone, body, template_version) values
  ('10000000-0000-0000-0000-0000000000c1', 'missed-call-textback:CA' || repeat('c', 32), '20000000-0000-0000-0000-0000000000c1', '+14235550301', '+14235550300', 'Hi', 'missed-call-textback@v1'),
  ('10000000-0000-0000-0000-0000000000d1', 'missed-call-textback:CA' || repeat('d', 32), '20000000-0000-0000-0000-0000000000d1', '+14235550401', '+14235550400', 'Hi', 'missed-call-textback@v1');

insert into public.opt_outs (tenant_id, phone, source) values
  ('10000000-0000-0000-0000-0000000000c1', '+14235550399', 'inbound_stop'),
  ('10000000-0000-0000-0000-0000000000d1', '+14235550499', 'inbound_stop');

do $$
begin
  begin
    insert into public.calls (tenant_id, call_sid, to_phone)
    values ('10000000-0000-0000-0000-0000000000c1', 'CA' || repeat('c', 32), '+14235550300');
    raise exception 'FAIL: duplicate call_sid accepted';
  exception when unique_violation then
    null;
  end;
  begin
    insert into public.outbound_messages (tenant_id, idempotency_key, to_phone, from_phone, body, template_version)
    values ('10000000-0000-0000-0000-0000000000c1', 'missed-call-textback:CA' || repeat('c', 32),
            '+14235550301', '+14235550300', 'Hi again', 'missed-call-textback@v1');
    raise exception 'FAIL: duplicate idempotency key accepted';
  exception when unique_violation then
    null;
  end;
  begin
    insert into public.tenant_phone_numbers (phone, tenant_id)
    values ('+14235550300', '10000000-0000-0000-0000-0000000000d1');
    raise exception 'FAIL: one number assigned to two tenants';
  exception when unique_violation then
    null;
  end;
  raise notice 'ok - duplicate calls, texts and number assignments are rejected';
end;
$$;

do $$
begin
  begin
    -- Tenant C call pointing at tenant D's lead.
    insert into public.calls (tenant_id, call_sid, to_phone, lead_id)
    values ('10000000-0000-0000-0000-0000000000c1', 'CA' || repeat('e', 32), '+14235550300',
            '20000000-0000-0000-0000-0000000000d1');
    raise exception 'FAIL: call linked to another tenant''s lead';
  exception when foreign_key_violation then
    null;
  end;
  begin
    insert into public.outbound_messages (tenant_id, idempotency_key, lead_id, to_phone, from_phone, body, template_version)
    values ('10000000-0000-0000-0000-0000000000c1', 'cross-tenant', '20000000-0000-0000-0000-0000000000d1',
            '+14235550401', '+14235550300', 'Hi', 'missed-call-textback@v1');
    raise exception 'FAIL: message linked to another tenant''s lead';
  exception when foreign_key_violation then
    null;
  end;
  begin
    insert into public.calls (tenant_id, call_sid, to_phone)
    values ('10000000-0000-0000-0000-0000000000c1', 'not-a-sid', '+14235550300');
    raise exception 'FAIL: malformed call_sid accepted';
  exception when check_violation then
    null;
  end;
  raise notice 'ok - calls and messages cannot point at another tenant''s lead';
end;
$$;

do $$
begin
  begin
    update public.calls set tenant_id = '10000000-0000-0000-0000-0000000000d1'
    where call_sid = 'CA' || repeat('c', 32);
    raise exception 'FAIL: call moved between tenants';
  exception when check_violation then
    null;
  end;
  raise notice 'ok - tenant_id is immutable on calls';
end;
$$;

-- Owner of tenant C ---------------------------------------------------------------

set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';

do $$
begin
  if (select count(*) from public.tenant_phone_numbers) <> 1
     or (select count(*) from public.calls) <> 1
     or (select count(*) from public.outbound_messages) <> 1
     or (select count(*) from public.opt_outs) <> 1 then
    raise exception 'FAIL: owner C should see exactly one row in each missed-call table';
  end if;
  if exists (select 1 from public.calls where tenant_id <> '10000000-0000-0000-0000-0000000000c1')
     or exists (select 1 from public.outbound_messages where tenant_id <> '10000000-0000-0000-0000-0000000000c1')
     or exists (select 1 from public.opt_outs where tenant_id <> '10000000-0000-0000-0000-0000000000c1')
     or exists (select 1 from public.tenant_phone_numbers where tenant_id <> '10000000-0000-0000-0000-0000000000c1') then
    raise exception 'FAIL: owner C can see tenant D rows';
  end if;
  raise notice 'ok - owner C reads only tenant C missed-call data';
end;
$$;

do $$
declare
  stmt text;
begin
  foreach stmt in array array[
    'insert into public.tenant_phone_numbers (phone, tenant_id) values (''+14235550398'', ''10000000-0000-0000-0000-0000000000c1'')',
    'insert into public.calls (tenant_id, call_sid, to_phone) values (''10000000-0000-0000-0000-0000000000c1'', ''CA' || repeat('f', 32) || ''', ''+14235550300'')',
    'insert into public.outbound_messages (tenant_id, idempotency_key, to_phone, from_phone, body, template_version) values (''10000000-0000-0000-0000-0000000000c1'', ''x'', ''+14235550301'', ''+14235550300'', ''Hi'', ''v1'')',
    'update public.outbound_messages set status = ''sent''',
    'delete from public.opt_outs',
    'insert into public.opt_outs (tenant_id, phone, source) values (''10000000-0000-0000-0000-0000000000c1'', ''+14235550398'', ''manual'')',
    'update public.calls set outcome = ''answered''',
    'delete from public.calls'
  ] loop
    begin
      execute stmt;
      raise exception 'FAIL: user was allowed: %', stmt;
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  foreach stmt in array array[
    'select public.find_or_create_missed_call_lead(''10000000-0000-0000-0000-0000000000c1'', ''+14235550398'', now())',
    'select public.claim_missed_call_textback(''10000000-0000-0000-0000-0000000000c1'', ''k'', null, ''+14235550398'', ''+14235550300'', ''Hi'', ''v1'', now())'
  ] loop
    begin
      execute stmt;
      raise exception 'FAIL: user was allowed: %', stmt;
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  raise notice 'ok - users cannot write missed-call tables';
end;
$$;

-- Anonymous -----------------------------------------------------------------------

reset request.jwt.claims;
set role anon;

do $$
declare
  t text;
begin
  foreach t in array array['tenant_phone_numbers', 'calls', 'outbound_messages', 'opt_outs'] loop
    begin
      execute format('select 1 from public.%I', t);
      raise exception 'FAIL: anon can read %', t;
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  begin
    perform public.find_or_create_missed_call_lead('10000000-0000-0000-0000-0000000000c1', '+14235550398', now());
    raise exception 'FAIL: anon can call find_or_create_missed_call_lead';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok - anon cannot read missed-call tables';
end;
$$;

reset role;

set role service_role;

-- Race-free helpers (as the service role) -----------------------------------------

do $$
declare
  first_lead uuid;
  second_lead uuid;
  msg uuid;
begin
  first_lead := public.find_or_create_missed_call_lead(
    '10000000-0000-0000-0000-0000000000c1', '+14235550350', now() - interval '24 hours');
  second_lead := public.find_or_create_missed_call_lead(
    '10000000-0000-0000-0000-0000000000c1', '+14235550350', now() - interval '24 hours');
  if first_lead is null or first_lead <> second_lead then
    raise exception 'FAIL: repeat caller got a second open lead';
  end if;

  msg := public.claim_missed_call_textback(
    '10000000-0000-0000-0000-0000000000c1', 'missed-call-textback:CA' || repeat('1', 32), first_lead,
    '+14235550350', '+14235550300', 'Hi', 'missed-call-textback@v1', now() - interval '24 hours');
  if msg is null then
    raise exception 'FAIL: first text-back was not claimed';
  end if;
  if public.claim_missed_call_textback(
    '10000000-0000-0000-0000-0000000000c1', 'missed-call-textback:CA' || repeat('1', 32), first_lead,
    '+14235550350', '+14235550300', 'Hi', 'missed-call-textback@v1', now() - interval '24 hours') is not null then
    raise exception 'FAIL: same call claimed twice';
  end if;
  if public.claim_missed_call_textback(
    '10000000-0000-0000-0000-0000000000c1', 'missed-call-textback:CA' || repeat('2', 32), first_lead,
    '+14235550350', '+14235550300', 'Hi', 'missed-call-textback@v1', now() - interval '24 hours') is not null then
    raise exception 'FAIL: second call within cooldown was claimed';
  end if;

  -- A refused text doesn't start the cooldown.
  update public.outbound_messages set status = 'failed' where id = msg;
  if public.claim_missed_call_textback(
    '10000000-0000-0000-0000-0000000000c1', 'missed-call-textback:CA' || repeat('3', 32), first_lead,
    '+14235550350', '+14235550300', 'Hi', 'missed-call-textback@v1', now() - interval '24 hours') is null then
    raise exception 'FAIL: a failed text blocked the next text-back';
  end if;

  -- Cooldown is per tenant: tenant D texting the same phone is unaffected.
  if public.claim_missed_call_textback(
    '10000000-0000-0000-0000-0000000000d1', 'missed-call-textback:CA' || repeat('4', 32), null,
    '+14235550350', '+14235550400', 'Hi', 'missed-call-textback@v1', now() - interval '24 hours') is null then
    raise exception 'FAIL: cooldown leaked across tenants';
  end if;
  raise notice 'ok - lead reuse and text-back cooldown are enforced in the database';
end;
$$;

reset role;

\echo 'All missed-call RLS tests passed.'
