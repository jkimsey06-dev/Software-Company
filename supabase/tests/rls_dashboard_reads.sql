-- RLS tests for what the owner dashboard reads and edits, signed in as a
-- user (anon key + session): leads, texts, conversations, calendar status,
-- and the tenant/membership lookups. Includes the staff role.

\set ON_ERROR_STOP on
\set QUIET on

reset role;
reset request.jwt.claims;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a8', 'staff-m@example.com'),
  ('00000000-0000-0000-0000-0000000000b8', 'owner-n@example.com'),
  ('00000000-0000-0000-0000-0000000000c8', 'nobody@example.com');

insert into public.tenants (id, slug, name) values
  ('10000000-0000-0000-0000-0000000000a8', 'tenant-m', 'Tenant M'),
  ('10000000-0000-0000-0000-0000000000b8', 'tenant-n', 'Tenant N');

insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-0000000000a8', '00000000-0000-0000-0000-0000000000a8', 'staff'),
  ('10000000-0000-0000-0000-0000000000b8', '00000000-0000-0000-0000-0000000000b8', 'owner');

insert into public.leads (id, tenant_id, phone, source) values
  ('20000000-0000-0000-0000-0000000000a8', '10000000-0000-0000-0000-0000000000a8', '+14235558001', 'missed_call'),
  ('20000000-0000-0000-0000-0000000000b8', '10000000-0000-0000-0000-0000000000b8', '+14235558101', 'missed_call');

set role service_role;

insert into public.inbound_messages (tenant_id, message_sid, from_phone, to_phone, body, lead_id) values
  ('10000000-0000-0000-0000-0000000000a8', 'SM' || repeat('8', 32), '+14235558001', '+14235558000', 'AC is out', '20000000-0000-0000-0000-0000000000a8'),
  ('10000000-0000-0000-0000-0000000000b8', 'SM' || repeat('9', 32), '+14235558101', '+14235558100', 'Roof leak', '20000000-0000-0000-0000-0000000000b8');

insert into public.outbound_messages (tenant_id, idempotency_key, lead_id, to_phone, from_phone, body, template_version) values
  ('10000000-0000-0000-0000-0000000000a8', 'dash-test-m', '20000000-0000-0000-0000-0000000000a8', '+14235558001', '+14235558000', 'Sorry we missed you', 'v1'),
  ('10000000-0000-0000-0000-0000000000b8', 'dash-test-n', '20000000-0000-0000-0000-0000000000b8', '+14235558101', '+14235558100', 'Sorry we missed you', 'v1');

insert into public.conversations (tenant_id, lead_id, customer_phone) values
  ('10000000-0000-0000-0000-0000000000a8', '20000000-0000-0000-0000-0000000000a8', '+14235558001'),
  ('10000000-0000-0000-0000-0000000000b8', '20000000-0000-0000-0000-0000000000b8', '+14235558101');

insert into public.calendar_connections (tenant_id, refresh_token_enc) values
  ('10000000-0000-0000-0000-0000000000a8', 'v1.sealed-m'),
  ('10000000-0000-0000-0000-0000000000b8', 'v1.sealed-n');

-- A staff member of M ---------------------------------------------------------
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a8","role":"authenticated"}';

do $$
declare
  m uuid := '10000000-0000-0000-0000-0000000000a8';
  n uuid := '10000000-0000-0000-0000-0000000000b8';
  rows int;
begin
  -- The membership lookup the dashboard does on every page, with the tenant embedded.
  if (select count(*) from public.tenant_members) <> 1
     or (select t.name from public.tenant_members tm join public.tenants t on t.id = tm.tenant_id) <> 'Tenant M' then
    raise exception 'FAIL: staff should see only their own membership and business';
  end if;

  if (select count(*) from public.leads) <> 1
     or (select count(*) from public.inbound_messages) <> 1
     or (select count(*) from public.outbound_messages) <> 1
     or (select count(*) from public.conversations) <> 1
     or (select count(*) from public.calendar_connections) <> 1 then
    raise exception 'FAIL: staff should see exactly their own business''s rows';
  end if;

  -- Asking for the other business by id returns nothing, not an error.
  if exists (select 1 from public.leads where tenant_id = n)
     or exists (select 1 from public.inbound_messages where tenant_id = n)
     or exists (select 1 from public.outbound_messages where tenant_id = n)
     or exists (select 1 from public.conversations where tenant_id = n)
     or exists (select 1 from public.calendar_connections where tenant_id = n) then
    raise exception 'FAIL: staff could read another business''s rows';
  end if;

  -- Edits the dashboard will make on their own lead.
  update public.leads set status = 'contacted', notes = 'Called back', address = '12 Main St'
  where id = '20000000-0000-0000-0000-0000000000a8';
  if (select status::text || notes || address from public.leads) <> 'contactedCalled back12 Main St' then
    raise exception 'FAIL: staff could not edit their own lead';
  end if;

  -- Not another business's lead.
  update public.leads set status = 'lost' where id = '20000000-0000-0000-0000-0000000000b8';
  get diagnostics rows = row_count;
  if rows <> 0 then raise exception 'FAIL: staff updated another business''s lead'; end if;

  -- Not moving a lead to another business, and not writing messages or the token.
  begin
    update public.leads set tenant_id = n where id = '20000000-0000-0000-0000-0000000000a8';
    raise exception 'FAIL: lead moved to another business';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.conversations set status = 'completed';
    raise exception 'FAIL: staff wrote to conversations';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform refresh_token_enc from public.calendar_connections;
    raise exception 'FAIL: staff read the calendar token';
  exception when insufficient_privilege then
    null;
  end;
  begin
    delete from public.leads;
    raise exception 'FAIL: staff deleted leads';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok - dashboard reads and edits stay inside the staff member''s business';
end;
$$;

-- A signed-in user who belongs to no business ----------------------------------
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c8","role":"authenticated"}';

do $$
begin
  if (select count(*) from public.tenant_members) <> 0
     or (select count(*) from public.tenants) <> 0
     or (select count(*) from public.leads) <> 0
     or (select count(*) from public.inbound_messages) <> 0
     or (select count(*) from public.outbound_messages) <> 0
     or (select count(*) from public.conversations) <> 0 then
    raise exception 'FAIL: a user with no business saw data';
  end if;
  raise notice 'ok - a user with no business sees nothing';
end;
$$;

reset request.jwt.claims;
set role anon;

do $$
begin
  begin
    perform 1 from public.leads;
    raise exception 'FAIL: anon read leads';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok - signed-out visitors see nothing';
end;
$$;

reset role;

\echo 'All dashboard RLS tests passed.'
