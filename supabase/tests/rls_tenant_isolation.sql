-- RLS tests for tenants, tenant_members and leads.
-- Run with: pnpm test:rls  (see supabase/scripts/test-rls-local.sh)
-- Every check raises an exception on failure, and psql stops on the first error.

\set ON_ERROR_STOP on
\set QUIET on

-- Fixtures (as the superuser running the tests) --------------------------------

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'owner-b@example.com'),
  ('00000000-0000-0000-0000-0000000000ab', 'staff-ab@example.com'),
  ('00000000-0000-0000-0000-0000000000ff', 'nobody@example.com');

insert into public.tenants (id, slug, name) values
  ('10000000-0000-0000-0000-00000000000a', 'tenant-a', 'Tenant A'),
  ('10000000-0000-0000-0000-00000000000b', 'tenant-b', 'Tenant B');

insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'owner'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'owner'),
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000ab', 'staff'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000ab', 'staff');

insert into public.leads (id, tenant_id, phone, source) values
  ('20000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-00000000000a', '+14235550101', 'missed_call'),
  ('20000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-00000000000a', '+14235550102', 'web_form'),
  ('20000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-00000000000b', '+14235550201', 'missed_call');

-- Schema-wide rules ------------------------------------------------------------

do $$
declare
  missing text;
begin
  select string_agg(c.relname, ', ') into missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if missing is not null then
    raise exception 'FAIL: RLS not enabled on public tables: %', missing;
  end if;

  -- Every client-data table needs tenant_id NOT NULL. tenants is the root.
  select string_agg(c.relname, ', ') into missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> 'tenants'
    and not exists (
      select 1 from pg_attribute a
      where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnotnull and not a.attisdropped
    );
  if missing is not null then
    raise exception 'FAIL: public tables without tenant_id NOT NULL: %', missing;
  end if;

  -- Views run as their owner unless security_invoker is set, which skips RLS.
  select string_agg(c.relname, ', ') into missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('v', 'm')
    and not coalesce('security_invoker=true' = any(c.reloptions), false);
  if missing is not null then
    raise exception 'FAIL: public views without security_invoker: %', missing;
  end if;

  select string_agg(distinct table_name, ', ') into missing
  from information_schema.role_table_grants
  where grantee = 'anon' and table_schema = 'public';
  if missing is not null then
    raise exception 'FAIL: anon has grants on public tables: %', missing;
  end if;
  raise notice 'ok - every public table has RLS and tenant_id NOT NULL, no unsafe views, no anon grants';
end;
$$;

-- Owner of tenant A ------------------------------------------------------------

set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';

do $$
begin
  if (select count(*) from public.leads) <> 2 then
    raise exception 'FAIL: owner A should see exactly 2 leads';
  end if;
  if exists (select 1 from public.leads where tenant_id <> '10000000-0000-0000-0000-00000000000a') then
    raise exception 'FAIL: owner A can see another tenant''s leads';
  end if;
  if (select array_agg(slug) from public.tenants) <> array['tenant-a'] then
    raise exception 'FAIL: owner A should see only tenant-a';
  end if;
  if (select count(*) from public.tenant_members) <> 1 then
    raise exception 'FAIL: owner A should see only their own membership';
  end if;
  raise notice 'ok - owner A reads only tenant A';
end;
$$;

do $$
begin
  insert into public.leads (tenant_id, phone, source)
  values ('10000000-0000-0000-0000-00000000000a', '+14235550103', 'manual');
  raise notice 'ok - owner A can insert a lead into tenant A';
end;
$$;

do $$
begin
  begin
    insert into public.leads (tenant_id, phone, source)
    values ('10000000-0000-0000-0000-00000000000b', '+14235550199', 'manual');
    raise exception 'FAIL: owner A inserted a lead into tenant B';
  exception when insufficient_privilege then
    raise notice 'ok - owner A cannot insert into tenant B';
  end;
end;
$$;

do $$
declare
  n int;
begin
  update public.leads set status = 'spam' where id = '20000000-0000-0000-0000-0000000000b1';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'FAIL: owner A updated a tenant B lead';
  end if;
  raise notice 'ok - owner A cannot update tenant B leads';
end;
$$;

do $$
begin
  begin
    update public.leads set tenant_id = '10000000-0000-0000-0000-00000000000b'
    where id = '20000000-0000-0000-0000-0000000000a1';
    raise exception 'FAIL: owner A moved a lead to tenant B';
  exception when insufficient_privilege or check_violation then
    raise notice 'ok - owner A cannot move a lead to tenant B';
  end;
end;
$$;

do $$
begin
  begin
    delete from public.leads where id = '20000000-0000-0000-0000-0000000000a1';
    raise exception 'FAIL: authenticated user deleted a lead';
  exception when insufficient_privilege then
    raise notice 'ok - leads cannot be deleted by users';
  end;
end;
$$;

do $$
begin
  begin
    insert into public.tenant_members (tenant_id, user_id)
    values ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a');
    raise exception 'FAIL: owner A added themselves to tenant B';
  exception when insufficient_privilege then
    raise notice 'ok - users cannot add memberships';
  end;
end;
$$;

do $$
begin
  begin
    update public.tenants set name = 'Hijacked' where id = '10000000-0000-0000-0000-00000000000a';
    raise exception 'FAIL: user updated a tenant row';
  exception when insufficient_privilege then
    raise notice 'ok - users cannot update tenants';
  end;
end;
$$;

do $$
begin
  begin
    insert into public.leads (tenant_id, phone, source, created_at)
    values ('10000000-0000-0000-0000-00000000000a', '+14235550104', 'manual', '1999-01-01');
    raise exception 'FAIL: user set created_at on a lead';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into public.leads (id, tenant_id, phone, source)
    values (gen_random_uuid(), '10000000-0000-0000-0000-00000000000a', '+14235550105', 'manual');
    raise exception 'FAIL: user chose a lead id';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok - users cannot set lead id or audit timestamps';
end;
$$;

do $$
declare
  stmt text;
begin
  foreach stmt in array array[
    'update public.tenant_members set role = ''owner'' where user_id = auth.uid()',
    'delete from public.tenant_members where user_id = auth.uid()',
    'insert into public.tenants (slug, name) values (''rogue'', ''Rogue'')',
    'delete from public.tenants where id = ''10000000-0000-0000-0000-00000000000a'''
  ] loop
    begin
      execute stmt;
      raise exception 'FAIL: user was allowed: %', stmt;
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  raise notice 'ok - users cannot change memberships or tenants';
end;
$$;

-- Staff in both tenants ---------------------------------------------------------

set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000ab","role":"authenticated"}';

do $$
begin
  if (select count(*) from public.leads) <> 4 then
    raise exception 'FAIL: two-tenant staff should see leads from both tenants';
  end if;
  begin
    update public.leads set tenant_id = '10000000-0000-0000-0000-00000000000b'
    where id = '20000000-0000-0000-0000-0000000000a1';
    raise exception 'FAIL: lead moved between tenants';
  exception when insufficient_privilege then
    raise notice 'ok - members of both tenants cannot move a lead between them';
  end;
end;
$$;

-- Signed-in user with no tenant -------------------------------------------------

set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000ff","role":"authenticated"}';

do $$
begin
  if (select count(*) from public.leads) <> 0
     or (select count(*) from public.tenants) <> 0
     or (select count(*) from public.tenant_members) <> 0 then
    raise exception 'FAIL: user with no membership can see data';
  end if;
  raise notice 'ok - user with no tenant sees nothing';
end;
$$;

-- No JWT at all ------------------------------------------------------------------

reset request.jwt.claims;

do $$
begin
  if (select count(*) from public.leads) <> 0 then
    raise exception 'FAIL: authenticated role without a user id can see leads';
  end if;
  raise notice 'ok - missing user id sees nothing';
end;
$$;

-- Anonymous ----------------------------------------------------------------------

set role anon;

do $$
begin
  begin
    perform 1 from public.leads;
    raise exception 'FAIL: anon can read leads';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform 1 from public.tenants;
    raise exception 'FAIL: anon can read tenants';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform private.is_tenant_member('10000000-0000-0000-0000-00000000000a');
    raise exception 'FAIL: anon can call is_tenant_member';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok - anon has no access';
end;
$$;

reset role;

-- Constraints ---------------------------------------------------------------------

-- The trigger is the backstop for server code that has full privileges.
do $$
begin
  begin
    update public.leads set tenant_id = '10000000-0000-0000-0000-00000000000b'
    where id = '20000000-0000-0000-0000-0000000000a1';
    raise exception 'FAIL: privileged update moved a lead between tenants';
  exception when check_violation then
    raise notice 'ok - tenant_id is immutable even for privileged roles';
  end;
end;
$$;

do $$
begin
  begin
    insert into public.leads (tenant_id, phone, source) values (null, '+14235550000', 'manual');
    raise exception 'FAIL: lead inserted without tenant_id';
  exception when not_null_violation then
    null;
  end;
  begin
    insert into public.leads (tenant_id, phone, source)
    values ('10000000-0000-0000-0000-00000000000a', '423-555-0000', 'manual');
    raise exception 'FAIL: lead inserted with non-E.164 phone';
  exception when check_violation then
    null;
  end;
  raise notice 'ok - tenant_id required and phone format enforced';
end;
$$;

\echo 'All RLS tests passed.'
