-- Owner notifications: an outbox of emails to the tenant's escalation contact.
--
-- A row is written (unique key per event) before anything is sent, then claimed
-- by exactly one sender at a time. Writes come only from server code using the
-- service role; members of the tenant can read their own rows.

create type public.notification_kind as enum ('new_lead', 'textback_failed');
create type public.notification_status as enum ('pending', 'sending', 'sent', 'failed', 'dead');

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind public.notification_kind not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  lead_id uuid,
  recipient_email text not null check (length(recipient_email) between 3 and 320),
  subject text not null check (length(subject) between 1 and 200 and subject !~ '[\r\n]'),
  body text not null check (length(body) between 1 and 5000),
  status public.notification_status not null default 'pending',
  attempts int not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  -- Set while a sender holds the row; a stale lock (crashed sender) can be retaken.
  locked_at timestamptz,
  provider_id text check (length(provider_id) <= 100),
  last_error_code text check (length(last_error_code) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, lead_id) references public.leads (tenant_id, id)
);

create index notifications_tenant_created_idx on public.notifications (tenant_id, created_at desc);
create index notifications_tenant_lead_idx on public.notifications (tenant_id, lead_id);
create index notifications_due_idx on public.notifications (next_attempt_at)
  where status in ('pending', 'failed', 'sending');

create trigger notifications_set_updated_at
  before update on public.notifications
  for each row execute function private.set_updated_at();

create trigger notifications_prevent_tenant_id_change
  before update on public.notifications
  for each row execute function private.prevent_tenant_id_change();

revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;

alter table public.notifications enable row level security;

create policy notifications_select_member
  on public.notifications for select to authenticated
  using (private.is_tenant_member(tenant_id));

-- Claims one notification for sending. Returns the row only to the caller that
-- won the claim; a row already sent, dead, or held by a live sender is skipped.
-- A lock older than p_stale_after is treated as abandoned.
create function public.claim_notification(p_id uuid, p_stale_after interval)
returns setof public.notifications
language sql
set search_path = ''
as $$
  update public.notifications
  set status = 'sending', locked_at = now(), attempts = attempts + 1
  where id = p_id
    and next_attempt_at <= now()
    and (
      status in ('pending', 'failed')
      or (status = 'sending' and locked_at < now() - p_stale_after)
    )
  returning *;
$$;

-- Ids of notifications due for a send attempt, oldest first.
create function public.due_notifications(p_limit int, p_stale_after interval)
returns setof uuid
language sql
stable
set search_path = ''
as $$
  select id from public.notifications
  where next_attempt_at <= now()
    and (
      status in ('pending', 'failed')
      or (status = 'sending' and locked_at < now() - p_stale_after)
    )
  order by next_attempt_at
  limit least(greatest(p_limit, 1), 100);
$$;

revoke all on function public.claim_notification(uuid, interval) from public, anon, authenticated;
revoke all on function public.due_notifications(int, interval) from public, anon, authenticated;
grant execute on function public.claim_notification(uuid, interval) to service_role;
grant execute on function public.due_notifications(int, interval) to service_role;
