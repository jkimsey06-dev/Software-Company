-- Tenants, tenant membership and leads, with row-level security.
--
-- Access model:
--   * A signed-in user belongs to one or more tenants through tenant_members.
--   * Authenticated users can only read and write rows for tenants they belong to.
--   * anon has no access. Server code that needs to cross tenants (webhooks,
--     onboarding) uses the service role, server-side only.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- Enums ----------------------------------------------------------------------
-- Keep in sync with packages/shared/src/lead.ts.

create type public.lead_urgency as enum ('emergency', 'soon', 'flexible', 'unknown');
create type public.lead_status as enum ('new', 'contacted', 'booked', 'won', 'lost', 'spam');
create type public.lead_source as enum ('missed_call', 'web_form', 'manual');
create type public.tenant_role as enum ('owner', 'staff');

-- Shared triggers ------------------------------------------------------------

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Rows never move between tenants, even if the user belongs to both.
create function private.prevent_tenant_id_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'tenant_id cannot be changed' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Tables ---------------------------------------------------------------------

-- The tenant itself. Its id is the tenant_id referenced everywhere else.
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 63),
  name text not null check (length(name) between 1 and 120),
  -- Validated by tenantConfigSchema (packages/shared) before it is written.
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger tenants_set_updated_at
  before update on public.tenants
  for each row execute function private.set_updated_at();

create table public.tenant_members (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.tenant_role not null default 'staff',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index tenant_members_user_id_idx on public.tenant_members (user_id);

create trigger tenant_members_prevent_tenant_id_change
  before update on public.tenant_members
  for each row execute function private.prevent_tenant_id_change();

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  name text check (length(name) <= 120),
  service_id text check (length(service_id) <= 63),
  area text check (length(area) <= 120),
  urgency public.lead_urgency not null default 'unknown',
  status public.lead_status not null default 'new',
  source public.lead_source not null,
  notes text check (length(notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Lets future tables use composite FKs (tenant_id, lead_id) so a child row
  -- can never point at another tenant's lead.
  unique (tenant_id, id)
);

create index leads_tenant_created_idx on public.leads (tenant_id, created_at desc);
create index leads_tenant_status_idx on public.leads (tenant_id, status);

create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function private.set_updated_at();

create trigger leads_prevent_tenant_id_change
  before update on public.leads
  for each row execute function private.prevent_tenant_id_change();

-- Membership check -----------------------------------------------------------
-- security definer so policies on tenant_members don't recurse into themselves.

create function private.is_tenant_member(check_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_members m
    where m.tenant_id = check_tenant_id
      and m.user_id = (select auth.uid())
  );
$$;

revoke all on function private.is_tenant_member(uuid) from public;
grant execute on function private.is_tenant_member(uuid) to authenticated;

-- Grants ---------------------------------------------------------------------
-- Supabase grants everything on public tables to anon and authenticated by
-- default. Narrow that so RLS is not the only line of defense.

revoke all on public.tenants, public.tenant_members, public.leads from anon, authenticated;

grant select on public.tenants to authenticated;
grant select on public.tenant_members to authenticated;
grant select on public.leads to authenticated;
-- Column-level: users can't set id, tenant_id on update, or audit timestamps.
grant insert (tenant_id, phone, name, service_id, area, urgency, source, notes)
  on public.leads to authenticated;
grant update (name, service_id, area, urgency, status, notes)
  on public.leads to authenticated;

-- Row-level security ---------------------------------------------------------

alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
alter table public.leads enable row level security;

create policy tenants_select_member
  on public.tenants for select to authenticated
  using (private.is_tenant_member(id));

create policy tenant_members_select_own
  on public.tenant_members for select to authenticated
  using (user_id = (select auth.uid()));

create policy leads_select_member
  on public.leads for select to authenticated
  using (private.is_tenant_member(tenant_id));

create policy leads_insert_member
  on public.leads for insert to authenticated
  with check (private.is_tenant_member(tenant_id));

create policy leads_update_member
  on public.leads for update to authenticated
  using (private.is_tenant_member(tenant_id))
  with check (private.is_tenant_member(tenant_id));

-- No delete policy: leads are closed out with status, not deleted.
