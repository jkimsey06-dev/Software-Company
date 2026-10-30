-- AI text conversations with customers: one conversation per customer phone
-- per tenant at a time, plus a log of every turn (what was decided, which model
-- and prompt version, and why).
--
-- Writes come only from server code using the service role. Members of the
-- tenant can read their own rows.

create type public.conversation_status as enum ('active', 'handed_off', 'completed');

alter type public.notification_kind add value if not exists 'conversation_update';
alter type public.notification_kind add value if not exists 'emergency';

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  lead_id uuid,
  customer_phone text not null check (customer_phone ~ '^\+[1-9][0-9]{7,14}$'),
  status public.conversation_status not null default 'active',
  -- Model-written replies sent so far; capped by the app.
  ai_replies int not null default 0 check (ai_replies >= 0),
  handoff_reason text check (length(handoff_reason) <= 64),
  -- Held by the one worker processing this conversation; expires on its own.
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, lead_id) references public.leads (tenant_id, id)
);

-- At most one active conversation per customer per tenant.
create unique index conversations_one_active_idx
  on public.conversations (tenant_id, customer_phone) where status = 'active';
create index conversations_tenant_phone_idx on public.conversations (tenant_id, customer_phone, created_at desc);
create index conversations_tenant_lead_idx on public.conversations (tenant_id, lead_id);

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function private.set_updated_at();

create trigger conversations_prevent_tenant_id_change
  before update on public.conversations
  for each row execute function private.prevent_tenant_id_change();

create table public.conversation_turns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  conversation_id uuid not null,
  inbound_message_sid text not null check (inbound_message_sid ~ '^(SM|MM)[0-9a-f]{32}$'),
  action text not null check (action in (
    'ai_reply', 'emergency', 'handoff', 'complete', 'fallback', 'ai_disclosure', 'turn_limit', 'skipped'
  )),
  safety_category text check (length(safety_category) <= 32),
  model text check (length(model) <= 64),
  prompt_version text check (length(prompt_version) <= 100),
  guard_violations text[] not null default '{}',
  input_tokens int check (input_tokens >= 0),
  output_tokens int check (output_tokens >= 0),
  outbound_message_id uuid,
  created_at timestamptz not null default now(),
  -- One decision per inbound message.
  unique (conversation_id, inbound_message_sid),
  foreign key (tenant_id, conversation_id) references public.conversations (tenant_id, id) on delete cascade
);

create index conversation_turns_tenant_created_idx on public.conversation_turns (tenant_id, created_at desc);
create index conversation_turns_conversation_idx on public.conversation_turns (tenant_id, conversation_id);

create trigger conversation_turns_prevent_tenant_id_change
  before update on public.conversation_turns
  for each row execute function private.prevent_tenant_id_change();

-- Grants and RLS ---------------------------------------------------------------------

revoke all on public.conversations, public.conversation_turns from anon, authenticated;
grant select on public.conversations, public.conversation_turns to authenticated;

alter table public.conversations enable row level security;
alter table public.conversation_turns enable row level security;

create policy conversations_select_member
  on public.conversations for select to authenticated
  using (private.is_tenant_member(tenant_id));

create policy conversation_turns_select_member
  on public.conversation_turns for select to authenticated
  using (private.is_tenant_member(tenant_id));

-- Functions (service role only) -------------------------------------------------------

-- Returns the customer's current conversation: the active one, or one handed
-- off or completed recently (so a person stays in charge); otherwise starts a
-- new active one. Locked per (tenant, phone) so two messages can't start two.
create function public.start_conversation(
  p_tenant_id uuid,
  p_phone text,
  p_lead_id uuid,
  p_reuse_after interval
)
returns setof public.conversations
language plpgsql
set search_path = ''
as $$
declare
  v_row public.conversations;
begin
  perform pg_advisory_xact_lock(hashtextextended('conversation:' || p_tenant_id || ':' || p_phone, 0));

  select * into v_row from public.conversations
  where tenant_id = p_tenant_id and customer_phone = p_phone
  order by created_at desc
  limit 1;

  if found and (v_row.status = 'active' or v_row.updated_at > now() - p_reuse_after) then
    return next v_row;
    return;
  end if;

  insert into public.conversations (tenant_id, customer_phone, lead_id)
  values (p_tenant_id, p_phone, p_lead_id)
  returning * into v_row;
  return next v_row;
end;
$$;

-- Takes the conversation for processing. True for exactly one caller until the
-- lease is released or expires.
create function public.acquire_conversation_lease(p_id uuid, p_seconds int)
returns boolean
language sql
set search_path = ''
as $$
  with taken as (
    update public.conversations
    set lease_until = now() + make_interval(secs => least(greatest(p_seconds, 1), 300))
    where id = p_id and (lease_until is null or lease_until < now())
    returning 1
  )
  select exists (select 1 from taken);
$$;

revoke all on function public.start_conversation(uuid, text, uuid, interval) from public, anon, authenticated;
revoke all on function public.acquire_conversation_lease(uuid, int) from public, anon, authenticated;
grant execute on function public.start_conversation(uuid, text, uuid, interval) to service_role;
grant execute on function public.acquire_conversation_lease(uuid, int) to service_role;
