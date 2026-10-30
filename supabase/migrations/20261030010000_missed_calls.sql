-- Missed-call machine: phone number routing, call log, outbound message
-- ledger and opt-outs.
--
-- Writes come only from server code (Twilio webhooks) using the service role.
-- Signed-in users can read their own tenant's rows; nothing else.

create type public.call_outcome as enum ('answered', 'missed');
create type public.outbound_message_status as enum ('pending', 'sent', 'failed', 'unknown');

-- Which tenant owns each Twilio number. A number belongs to exactly one tenant.
create table public.tenant_phone_numbers (
  phone text primary key check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index tenant_phone_numbers_tenant_idx on public.tenant_phone_numbers (tenant_id);

create trigger tenant_phone_numbers_prevent_tenant_id_change
  before update on public.tenant_phone_numbers
  for each row execute function private.prevent_tenant_id_change();

-- One row per inbound call. call_sid is unique, so a repeated webhook is a no-op.
create table public.calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  call_sid text not null unique check (call_sid ~ '^CA[0-9a-f]{32}$'),
  -- Null when the caller's number is withheld or not a valid E.164 number.
  from_phone text check (from_phone ~ '^\+[1-9][0-9]{7,14}$'),
  to_phone text not null check (to_phone ~ '^\+[1-9][0-9]{7,14}$'),
  outcome public.call_outcome,
  dial_status text check (length(dial_status) <= 32),
  lead_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Composite FK: a call can only point at a lead in the same tenant.
  foreign key (tenant_id, lead_id) references public.leads (tenant_id, id)
);

create index calls_tenant_created_idx on public.calls (tenant_id, created_at desc);

create trigger calls_set_updated_at
  before update on public.calls
  for each row execute function private.set_updated_at();

create trigger calls_prevent_tenant_id_change
  before update on public.calls
  for each row execute function private.prevent_tenant_id_change();

-- Every outbound text. The row is claimed (inserted) before sending; the
-- unique idempotency key means a retry can never send the same text twice.
-- 'unknown' = we can't tell whether the provider sent it; never auto-retried.
create table public.outbound_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  lead_id uuid,
  to_phone text not null check (to_phone ~ '^\+[1-9][0-9]{7,14}$'),
  from_phone text not null check (from_phone ~ '^\+[1-9][0-9]{7,14}$'),
  body text not null check (length(body) between 1 and 1600),
  template_version text not null check (length(template_version) <= 100),
  status public.outbound_message_status not null default 'pending',
  provider_sid text check (length(provider_sid) <= 64),
  error_code text check (length(error_code) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, lead_id) references public.leads (tenant_id, id)
);

create index outbound_messages_tenant_created_idx
  on public.outbound_messages (tenant_id, created_at desc);

create trigger outbound_messages_set_updated_at
  before update on public.outbound_messages
  for each row execute function private.set_updated_at();

create trigger outbound_messages_prevent_tenant_id_change
  before update on public.outbound_messages
  for each row execute function private.prevent_tenant_id_change();

-- People who replied STOP (or the carrier told us they're unsubscribed).
-- Checked before every outbound text for that tenant.
create table public.opt_outs (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  source text not null check (source in ('inbound_stop', 'carrier', 'manual')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, phone)
);

create trigger opt_outs_prevent_tenant_id_change
  before update on public.opt_outs
  for each row execute function private.prevent_tenant_id_change();

-- Grants: read-only for signed-in users, nothing for anon. ---------------------

revoke all on public.tenant_phone_numbers, public.calls, public.outbound_messages, public.opt_outs
  from anon, authenticated;

grant select on public.tenant_phone_numbers, public.calls, public.outbound_messages, public.opt_outs
  to authenticated;

-- Row-level security -------------------------------------------------------------

alter table public.tenant_phone_numbers enable row level security;
alter table public.calls enable row level security;
alter table public.outbound_messages enable row level security;
alter table public.opt_outs enable row level security;

create policy tenant_phone_numbers_select_member
  on public.tenant_phone_numbers for select to authenticated
  using (private.is_tenant_member(tenant_id));

create policy calls_select_member
  on public.calls for select to authenticated
  using (private.is_tenant_member(tenant_id));

create policy outbound_messages_select_member
  on public.outbound_messages for select to authenticated
  using (private.is_tenant_member(tenant_id));

create policy opt_outs_select_member
  on public.opt_outs for select to authenticated
  using (private.is_tenant_member(tenant_id));
