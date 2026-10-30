-- RLS tests for calendar_connections, calendar_link_uses and leads.address.

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
    'delete from public.calendar_connections'
  ] loop
    begin
      execute stmt;
      raise exception 'FAIL: user was allowed: %', stmt;
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  raise notice 'ok - owners see connection status only, never the token, and cannot write';
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
