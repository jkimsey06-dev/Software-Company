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
    values ('10000000-0000-0000-0000-0000000000a7', 'SM' || repeat('d', 32), '+14235551001', '+14235551000', repeat('x', 1601));
    raise exception 'FAIL: oversized body accepted';
  exception when check_violation then
    null;
  end;
  raise notice 'ok - inbound messages are unique per MessageSid and tied to their own tenant';
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
    'delete from public.inbound_messages'
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
