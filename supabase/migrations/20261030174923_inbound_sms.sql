-- Inbound texts from customers: a log of every message (one row per Twilio
-- MessageSid, so a repeated webhook is a no-op), plus owner emails for replies.
--
-- Writes come only from server code using the service role. Members of the
-- tenant can read their own rows.

create type public.inbound_keyword as enum ('stop', 'start', 'help');

alter type public.notification_kind add value if not exists 'customer_reply';

create table public.inbound_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  message_sid text not null unique check (message_sid ~ '^(SM|MM)[0-9a-f]{32}$'),
  from_phone text not null check (from_phone ~ '^\+[1-9][0-9]{7,14}$'),
  to_phone text not null check (to_phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- Untrusted customer text. Never treated as instructions anywhere.
  body text not null check (length(body) <= 5000),
  -- Set when the message was an opt-out/opt-in/help keyword.
  keyword public.inbound_keyword,
  lead_id uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, lead_id) references public.leads (tenant_id, id)
);

create index inbound_messages_tenant_created_idx on public.inbound_messages (tenant_id, created_at desc);
create index inbound_messages_tenant_phone_idx on public.inbound_messages (tenant_id, from_phone, created_at desc);
create index inbound_messages_tenant_lead_idx on public.inbound_messages (tenant_id, lead_id);

create trigger inbound_messages_prevent_tenant_id_change
  before update on public.inbound_messages
  for each row execute function private.prevent_tenant_id_change();

revoke all on public.inbound_messages from anon, authenticated;
grant select on public.inbound_messages to authenticated;

alter table public.inbound_messages enable row level security;

create policy inbound_messages_select_member
  on public.inbound_messages for select to authenticated
  using (private.is_tenant_member(tenant_id));

-- Records an inbound text and applies its opt-out/opt-in in one transaction,
-- locked per (tenant, phone) so concurrent deliveries apply in a single order.
-- Returns true if this MessageSid is new.
--   * STOP and START apply only for a new message, so a redelivered or replayed
--     old message can never undo a later one. (Recording the message and its
--     opt-out change together means a new STOP is never half-applied.)
--   * START only clears opt-outs the customer made (by text, or Twilio's record
--     of their STOP), never one entered by hand.
create function public.record_inbound_sms(
  p_tenant_id uuid,
  p_message_sid text,
  p_from_phone text,
  p_to_phone text,
  p_body text,
  p_keyword public.inbound_keyword,
  p_lead_id uuid
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_new boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('optout:' || p_tenant_id || ':' || p_from_phone, 0));

  insert into public.inbound_messages (tenant_id, message_sid, from_phone, to_phone, body, keyword, lead_id)
  values (p_tenant_id, p_message_sid, p_from_phone, p_to_phone, p_body, p_keyword, p_lead_id)
  on conflict (message_sid) do nothing;
  v_new := found;

  if p_keyword = 'stop' and v_new then
    insert into public.opt_outs (tenant_id, phone, source)
    values (p_tenant_id, p_from_phone, 'inbound_stop')
    on conflict (tenant_id, phone) do nothing;
  elsif p_keyword = 'start' and v_new then
    delete from public.opt_outs
    where tenant_id = p_tenant_id and phone = p_from_phone and source in ('inbound_stop', 'carrier');
  end if;

  return v_new;
end;
$$;

revoke all on function public.record_inbound_sms(uuid, text, text, text, text, public.inbound_keyword, uuid)
  from public, anon, authenticated;
grant execute on function public.record_inbound_sms(uuid, text, text, text, text, public.inbound_keyword, uuid)
  to service_role;
