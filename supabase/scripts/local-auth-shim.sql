-- Minimal stand-in for the Supabase roles and auth schema, so migrations and
-- RLS tests can run against a plain local Postgres. Only ever loaded into a
-- throwaway database created by test-rls-local.sh. Never run this on a real
-- Supabase project.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- Same contract as Supabase: the user id comes from the request's JWT claims.
create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;

-- Mimic Supabase's default privileges so the migration's revokes are tested.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- Supabase projects ship this SECURITY DEFINER event-trigger function in public,
-- executable by API roles. Mirror it so the tests see what the platform has.
create function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
as $$
begin
  null;
end;
$$;
grant execute on function public.rls_auto_enable() to anon, authenticated, service_role;
