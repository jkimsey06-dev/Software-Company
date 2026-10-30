-- RLS, constraint and claim tests for public.notifications.

\set ON_ERROR_STOP on
\set QUIET on

reset role;
reset request.jwt.claims;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'owner-e@example.com'),
  ('00000000-0000-0000-0000-0000000000f1', 'owner-f@example.com');

insert into public.tenants (id, slug, name) values
  ('10000000-0000-0000-0000-0000000000e1', 'tenant-e', 'Tenant E'),
  ('10000000-0000-0000-0000-0000000000f1', 'tenant-f', 'Tenant F');

insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1', 'owner'),
  ('10000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f1', 'owner');

insert into public.leads (id, tenant_id, phone, source) values
  ('20000000-0000-0000-0000-0000000000e1', '10000000-0000-0000-0000-0000000000e1', '+14235550801', 'missed_call'),
  ('20000000-0000-0000-0000-0000000000f1', '10000000-0000-0000-0000-0000000000f1', '+14235550901', 'missed_call');

set role service_role;

insert into public.notifications (id, tenant_id, kind, idempotency_key, lead_id, recipient_email, subject, body) values
  ('30000000-0000-0000-0000-0000000000e1', '10000000-0000-0000-0000-0000000000e1', 'new_lead', 'new-lead:e1',
   '20000000-0000-0000-0000-0000000000e1', 'owner-e@example.com', 'New lead', 'Body'),
  ('30000000-0000-0000-0000-0000000000f1', '10000000-0000-0000-0000-0000000000f1', 'new_lead', 'new-lead:f1',
   '20000000-0000-0000-0000-0000000000f1', 'owner-f@example.com', 'New lead', 'Body');

do $$
begin
  begin
    insert into public.notifications (tenant_id, kind, idempotency_key, recipient_email, subject, body)
    values ('10000000-0000-0000-0000-0000000000e1', 'new_lead', 'new-lead:e1', 'x@example.com', 'Dup', 'Dup');
    raise exception 'FAIL: duplicate notification key accepted';
  exception when unique_violation then
    null;
  end;
  begin
    insert into public.notifications (tenant_id, kind, idempotency_key, lead_id, recipient_email, subject, body)
    values ('10000000-0000-0000-0000-0000000000e1', 'new_lead', 'cross', '20000000-0000-0000-0000-0000000000f1',
            'x@example.com', 'S', 'B');
    raise exception 'FAIL: notification linked to another tenant''s lead';
  exception when foreign_key_violation then
    null;
  end;
  begin
    insert into public.notifications (tenant_id, kind, idempotency_key, recipient_email, subject, body)
    values ('10000000-0000-0000-0000-0000000000e1', 'new_lead', 'hdr', 'x@example.com', E'Hi\r\nBcc: evil@example.com', 'B');
    raise exception 'FAIL: subject with a line break accepted';
  exception when check_violation then
    null;
  end;
  raise notice 'ok - notification keys, lead links and subjects are constrained';
end;
$$;

-- Claiming ---------------------------------------------------------------------------

do $$
declare
  n int;
begin
  select count(*) into n from public.claim_notification('30000000-0000-0000-0000-0000000000e1', interval '5 minutes');
  if n <> 1 then raise exception 'FAIL: first claim did not win'; end if;
  select count(*) into n from public.claim_notification('30000000-0000-0000-0000-0000000000e1', interval '5 minutes');
  if n <> 0 then raise exception 'FAIL: a held notification was claimed twice'; end if;

  -- A sender that died long ago: its lock can be retaken.
  update public.notifications set locked_at = now() - interval '10 minutes'
  where id = '30000000-0000-0000-0000-0000000000e1';
  select count(*) into n from public.claim_notification('30000000-0000-0000-0000-0000000000e1', interval '5 minutes');
  if n <> 1 then raise exception 'FAIL: stale lock was not retaken'; end if;

  update public.notifications set status = 'sent' where id = '30000000-0000-0000-0000-0000000000e1';
  select count(*) into n from public.claim_notification('30000000-0000-0000-0000-0000000000e1', interval '0 seconds');
  if n <> 0 then raise exception 'FAIL: a sent notification was claimed'; end if;

  -- Not due yet.
  update public.notifications set status = 'failed', next_attempt_at = now() + interval '1 hour'
  where id = '30000000-0000-0000-0000-0000000000f1';
  select count(*) into n from public.claim_notification('30000000-0000-0000-0000-0000000000f1', interval '5 minutes');
  if n <> 0 then raise exception 'FAIL: claimed before next_attempt_at'; end if;
  if exists (select 1 from public.due_notifications(10, interval '5 minutes')) then
    raise exception 'FAIL: nothing should be due';
  end if;

  update public.notifications set next_attempt_at = now() where id = '30000000-0000-0000-0000-0000000000f1';
  if not exists (select 1 from public.due_notifications(10, interval '5 minutes') d where d = '30000000-0000-0000-0000-0000000000f1') then
    raise exception 'FAIL: failed notification is not due for retry';
  end if;
  -- Older than 12h: never claimed, and expire_notifications marks it dead.
  update public.notifications set status = 'pending', next_attempt_at = now(), created_at = now() - interval '13 hours'
  where id = '30000000-0000-0000-0000-0000000000f1';
  select count(*) into n from public.claim_notification('30000000-0000-0000-0000-0000000000f1', interval '5 minutes');
  if n <> 0 then raise exception 'FAIL: a 13h-old notification was claimed'; end if;
  if public.expire_notifications() <> 1 then raise exception 'FAIL: old notification not expired'; end if;
  if (select status from public.notifications where id = '30000000-0000-0000-0000-0000000000f1') <> 'dead' then
    raise exception 'FAIL: expired notification is not dead';
  end if;
  if public.expire_notifications() <> 0 then raise exception 'FAIL: expired twice'; end if;
  raise notice 'ok - one sender per notification, stale locks retaken, sent and expired rows never sent';
end;
$$;

-- Owner of tenant E -------------------------------------------------------------------

set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}';

do $$
declare
  stmt text;
begin
  if (select count(*) from public.notifications) <> 1
     or exists (select 1 from public.notifications where tenant_id <> '10000000-0000-0000-0000-0000000000e1') then
    raise exception 'FAIL: owner E should see only tenant E notifications';
  end if;
  foreach stmt in array array[
    'update public.notifications set status = ''pending''',
    'delete from public.notifications',
    'insert into public.notifications (tenant_id, kind, idempotency_key, recipient_email, subject, body) values (''10000000-0000-0000-0000-0000000000e1'', ''new_lead'', ''u'', ''x@example.com'', ''S'', ''B'')',
    'select * from public.claim_notification(''30000000-0000-0000-0000-0000000000e1'', interval ''0 seconds'')',
    'select * from public.due_notifications(10, interval ''0 seconds'')',
    'select public.expire_notifications()'
  ] loop
    begin
      execute stmt;
      raise exception 'FAIL: user was allowed: %', stmt;
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  raise notice 'ok - owner E reads only tenant E notifications and cannot write or claim';
end;
$$;

reset request.jwt.claims;
set role anon;

do $$
begin
  begin
    perform 1 from public.notifications;
    raise exception 'FAIL: anon can read notifications';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok - anon cannot read notifications';
end;
$$;

reset role;

\echo 'All notification RLS tests passed.'
