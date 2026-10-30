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

-- Race-free helpers for the webhook ------------------------------------------------
-- Two webhooks for the same caller can run at once (redials, two numbers). Each
-- helper takes a transaction lock on (tenant, phone) so check-then-insert is atomic.
-- Server only: callable by the service role, not by users.

create function public.find_or_create_missed_call_lead(
  p_tenant_id uuid,
  p_phone text,
  p_reuse_since timestamptz
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_lead_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('lead:' || p_tenant_id || ':' || p_phone, 0));

  select id into v_lead_id
  from public.leads
  where tenant_id = p_tenant_id
    and phone = p_phone
    and status in ('new', 'contacted')
    and created_at >= p_reuse_since
  order by created_at desc
  limit 1;

  if v_lead_id is null then
    insert into public.leads (tenant_id, phone, source)
    values (p_tenant_id, p_phone, 'missed_call')
    returning id into v_lead_id;
  end if;

  return v_lead_id;
end;
$$;

-- Returns the new message id, or null if this call already has a text-back or
-- the caller got one since p_cooldown_since. Never send when it returns null.
create function public.claim_missed_call_textback(
  p_tenant_id uuid,
  p_idempotency_key text,
  p_lead_id uuid,
  p_to_phone text,
  p_from_phone text,
  p_body text,
  p_template_version text,
  p_cooldown_since timestamptz
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('textback:' || p_tenant_id || ':' || p_to_phone, 0));

  if exists (
    select 1 from public.outbound_messages
    where tenant_id = p_tenant_id
      and (
        idempotency_key = p_idempotency_key
        or (
          to_phone = p_to_phone
          and idempotency_key like 'missed-call-textback:%'
          -- 'failed' = Twilio refused it, nothing reached the caller.
          and status in ('pending', 'sent', 'unknown')
          and created_at >= p_cooldown_since
        )
      )
  ) then
    return null;
  end if;

  insert into public.outbound_messages
    (tenant_id, idempotency_key, lead_id, to_phone, from_phone, body, template_version)
  values
    (p_tenant_id, p_idempotency_key, p_lead_id, p_to_phone, p_from_phone, p_body, p_template_version)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.find_or_create_missed_call_lead(uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.claim_missed_call_textback(uuid, text, uuid, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.find_or_create_missed_call_lead(uuid, text, timestamptz)
  to service_role;
grant execute on function public.claim_missed_call_textback(uuid, text, uuid, text, text, text, text, timestamptz)
  to service_role;
