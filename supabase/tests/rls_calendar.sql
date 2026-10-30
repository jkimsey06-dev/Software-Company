-- RLS tests for calendar_connections, calendar_link_uses, estimate_holds and leads.address.

\set ON_ERROR_STOP on
\set QUIET on

reset role;
reset request.jwt.claims;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e7', 'owner-k@example.com'),
  ('00000000-0000-0000-0000-0000000000f7', 'owner-l@example.com');

insert into public.tenants (id, slug, name) values
  ('10000000-0000-0000-0000-0000000000e7', 'tenant-k', 'Tenant K'),
  ('10000000-0000-0000-0000-0000000000f7', 'tenant-l', 'Tenant L');

insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-0000000000e7', '00000000-0000-0000-0000-0000000000e7', 'owner'),
  ('10000000-0000-0000-0000-0000000000f7', '00000000-0000-0000-0000-0000000000f7', 'owner');

set role service_role;

insert into public.calendar_connections (tenant_id, refresh_token_enc) values
  ('10000000-0000-0000-0000-0000000000e7', 'v1.sealed-k'),
  ('10000000-0000-0000-0000-0000000000f7', 'v1.sealed-l');

insert into public.calendar_link_uses (nonce, tenant_id) values
  ('nonce-0000000000000001', '10000000-0000-0000-0000-0000000000e7');

do $$
begin
  begin
    insert into public.calendar_link_uses (nonce, tenant_id) values ('nonce-0000000000000001', '10000000-0000-0000-0000-0000000000e7');
    raise exception 'FAIL: a connect link was used twice';
  exception when unique_violation then
    null;
  end;
  begin
    update public.calendar_connections set tenant_id = '10000000-0000-0000-0000-0000000000f7'
    where tenant_id = '10000000-0000-0000-0000-0000000000e7';
    raise exception 'FAIL: a calendar connection moved between tenants';
  exception when check_violation or unique_violation then
    null;
  end;
  raise notice 'ok - connect links are single-use; connections stay with their tenant';
end;
$$;

-- Time holds: two customers of one tenant can't hold overlapping times.
insert into public.leads (id, tenant_id, phone, source) values
  ('20000000-0000-0000-0000-0000000000e7', '10000000-0000-0000-0000-0000000000e7', '+14235553001', 'missed_call');
insert into public.conversations (id, tenant_id, customer_phone, status) values
  ('30000000-0000-0000-0000-0000000000e1', '10000000-0000-0000-0000-0000000000e7', '+14235553001', 'active'),
  ('30000000-0000-0000-0000-0000000000e2', '10000000-0000-0000-0000-0000000000e7', '+14235553002', 'active'),
  ('30000000-0000-0000-0000-0000000000f1', '10000000-0000-0000-0000-0000000000f7', '+14235553101', 'active');

do $$
declare
  k uuid := '10000000-0000-0000-0000-0000000000e7';
  t timestamptz := '2026-11-02 13:00+00';
begin
  if not public.claim_estimate_slot(k, '30000000-0000-0000-0000-0000000000e1', t, t + interval '1 hour', interval '30 minutes') then
    raise exception 'FAIL: first hold refused';
  end if;
  if not public.claim_estimate_slot(k, '30000000-0000-0000-0000-0000000000e1', t, t + interval '1 hour', interval '30 minutes') then
    raise exception 'FAIL: a retry by the same conversation was refused';
  end if;
  if public.claim_estimate_slot(k, '30000000-0000-0000-0000-0000000000e2', t + interval '30 minutes', t + interval '90 minutes', interval '30 minutes') then
    raise exception 'FAIL: an overlapping time was held for a second customer';
  end if;
  if not public.claim_estimate_slot(k, '30000000-0000-0000-0000-0000000000e2', t + interval '2 hours', t + interval '3 hours', interval '30 minutes') then
    raise exception 'FAIL: a time after the buffer was refused';
  end if;
  if not public.claim_estimate_slot('10000000-0000-0000-0000-0000000000f7', '30000000-0000-0000-0000-0000000000f1', t, t + interval '1 hour', interval '30 minutes') then
    raise exception 'FAIL: another tenant''s hold blocked this tenant';
  end if;
  raise notice 'ok - time holds stop overlapping bookings within a tenant only';
end;
$$;

set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e7","role":"authenticated"}';

do $$
declare
  stmt text;
begin
  if (select count(*) from public.calendar_connections) <> 1
     or (select status from public.calendar_connections) <> 'connected' then
    raise exception 'FAIL: owner K should see only their own connection status';
  end if;
  foreach stmt in array array[
    'select refresh_token_enc from public.calendar_connections',
    'select * from public.calendar_connections',
    'select * from public.calendar_link_uses',
    'update public.calendar_connections set status = ''revoked''',
    'insert into public.calendar_connections (tenant_id, refresh_token_enc) values (''10000000-0000-0000-0000-0000000000e7'', ''x'')',
    'delete from public.calendar_connections',
    'select public.claim_estimate_slot(''10000000-0000-0000-0000-0000000000e7'', gen_random_uuid(), now(), now() + interval ''1 hour'', interval ''0'')',
    'insert into public.estimate_holds (conversation_id, tenant_id, starts_at, ends_at) values (gen_random_uuid(), ''10000000-0000-0000-0000-0000000000e7'', now(), now() + interval ''1 hour'')'
  ] loop
    begin
      execute stmt;
      raise exception 'FAIL: user was allowed: %', stmt;
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  if (select count(*) from public.estimate_holds) <> 2 or exists (select 1 from public.estimate_holds where tenant_id <> '10000000-0000-0000-0000-0000000000e7') then
    raise exception 'FAIL: owner K should see only tenant K holds';
  end if;
  -- Owners can correct a lead's address.
  update public.leads set address = '12 Main St' where id = '20000000-0000-0000-0000-0000000000e7';
  if (select address from public.leads where id = '20000000-0000-0000-0000-0000000000e7') <> '12 Main St' then
    raise exception 'FAIL: owner could not set the lead address';
  end if;
  raise notice 'ok - owners see connection status only, never the token, cannot write, and can fix addresses';
end;
$$;

reset request.jwt.claims;
set role anon;

do $$
begin
  begin
    perform 1 from public.calendar_connections;
    raise exception 'FAIL: anon can read calendar connections';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok - anon cannot read calendar connections';
end;
$$;

reset role;

\echo 'All calendar RLS tests passed.'
