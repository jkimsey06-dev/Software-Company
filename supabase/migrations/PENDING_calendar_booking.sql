-- Estimate booking from the owner's Google Calendar.
--
-- calendar_connections holds each tenant's Google refresh token, encrypted by
-- the app (AES-256-GCM, key only in the server environment). Members can see
-- whether a calendar is connected, never the token. Writes are server-only.

create table public.calendar_connections (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  provider text not null default 'google' check (provider = 'google'),
  calendar_id text not null default 'primary' check (length(calendar_id) between 1 and 256),
  refresh_token_enc text not null check (length(refresh_token_enc) between 1 and 4000),
  status text not null default 'connected' check (status in ('connected', 'revoked')),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger calendar_connections_set_updated_at
  before update on public.calendar_connections
  for each row execute function private.set_updated_at();

create trigger calendar_connections_prevent_tenant_id_change
  before update on public.calendar_connections
  for each row execute function private.prevent_tenant_id_change();

-- Each connect link works once.
create table public.calendar_link_uses (
  nonce text primary key check (length(nonce) between 16 and 64),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  used_at timestamptz not null default now()
);

-- Street address for on-site estimates (customer-provided, untrusted).
alter table public.leads add column address text check (length(address) <= 200);

-- Booking state on the conversation.
-- 'booking': the event is being created (set before calling Google, so a retry
-- finishes the same booking instead of starting over).
create type public.conversation_stage as enum ('qualifying', 'choosing_time', 'asking_address', 'booking', 'booked');

alter table public.conversations
  add column stage public.conversation_stage not null default 'qualifying',
  add column offered_slots timestamptz[] not null default '{}',
  add column chosen_slot timestamptz,
  add column offer_rounds int not null default 0 check (offer_rounds >= 0),
  add column booked_event_id text check (length(booked_event_id) <= 1024),
  -- Kept if the chosen time is taken, so the customer isn't asked again.
  add column address text check (length(address) <= 150);

-- One time hold per conversation. Claimed under a per-tenant lock so two
-- customers can't book overlapping times at once.
create table public.estimate_holds (
  conversation_id uuid primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, conversation_id) references public.conversations (tenant_id, id) on delete cascade
);

create index estimate_holds_tenant_time_idx on public.estimate_holds (tenant_id, starts_at);

create trigger estimate_holds_prevent_tenant_id_change
  before update on public.estimate_holds
  for each row execute function private.prevent_tenant_id_change();

-- True if this conversation now holds [start, end); false if another
-- conversation of the same tenant holds an overlapping time (with buffer).
create function public.claim_estimate_slot(
  p_tenant_id uuid,
  p_conversation_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_buffer interval
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('estimate-slots:' || p_tenant_id, 0));
  if exists (
    select 1 from public.estimate_holds h
    where h.tenant_id = p_tenant_id
      and h.conversation_id <> p_conversation_id
      and h.starts_at < p_end + p_buffer
      and p_start - p_buffer < h.ends_at
  ) then
    return false;
  end if;
  insert into public.estimate_holds (conversation_id, tenant_id, starts_at, ends_at)
  values (p_conversation_id, p_tenant_id, p_start, p_end)
  on conflict (conversation_id) do update set starts_at = excluded.starts_at, ends_at = excluded.ends_at;
  return true;
end;
$$;

revoke all on function public.claim_estimate_slot(uuid, uuid, timestamptz, timestamptz, interval) from public, anon, authenticated;
grant execute on function public.claim_estimate_slot(uuid, uuid, timestamptz, timestamptz, interval) to service_role;

alter table public.conversation_turns drop constraint conversation_turns_action_check;
alter table public.conversation_turns add constraint conversation_turns_action_check check (action in (
  'ask', 'complete', 'out_of_area', 'unlisted_service', 'emergency', 'handoff', 'fallback',
  'turn_limit', 'skipped', 'merged', 'send_failed', 'opted_out', 'timed_out',
  'offer_times', 'ask_address', 'booked', 'slot_taken'
));

alter type public.notification_kind add value if not exists 'estimate_booked';
alter type public.notification_kind add value if not exists 'calendar_reconnect';

-- Grants and RLS ----------------------------------------------------------------------

revoke all on public.calendar_connections, public.calendar_link_uses, public.estimate_holds from anon, authenticated;
grant select on public.estimate_holds to authenticated;
-- Column-level: members see the connection status, never the token.
grant select (tenant_id, provider, calendar_id, status, connected_at, updated_at)
  on public.calendar_connections to authenticated;

-- Owners can correct the address on their leads.
grant insert (address) on public.leads to authenticated;
grant update (address) on public.leads to authenticated;

alter table public.calendar_connections enable row level security;
alter table public.calendar_link_uses enable row level security;
alter table public.estimate_holds enable row level security;

create policy estimate_holds_select_member
  on public.estimate_holds for select to authenticated
  using (private.is_tenant_member(tenant_id));

create policy calendar_connections_select_member
  on public.calendar_connections for select to authenticated
  using (private.is_tenant_member(tenant_id));
-- calendar_link_uses: no policies; server only.
