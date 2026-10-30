-- Indexes for the composite lead foreign keys, and lock down a Supabase
-- platform function the security advisor flagged.

-- Supabase performance advisor: foreign keys without a covering index.
create index calls_tenant_lead_idx on public.calls (tenant_id, lead_id);
create index outbound_messages_tenant_lead_idx on public.outbound_messages (tenant_id, lead_id);

-- Supabase security advisor: public.rls_auto_enable() is the SECURITY DEFINER
-- function behind the platform's ensure_rls event trigger, and was executable
-- by anon and authenticated through /rest/v1/rpc. The event trigger still runs
-- for the function owner; API roles have no reason to call it.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;
