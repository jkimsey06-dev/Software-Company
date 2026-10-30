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
  body text not null check (length(body) <= 1600),
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
