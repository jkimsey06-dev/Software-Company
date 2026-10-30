-- Cover the foreign keys added by calendar_booking (advisor: unindexed_foreign_keys).
create index calendar_link_uses_tenant_idx on public.calendar_link_uses (tenant_id);
create index estimate_holds_tenant_conversation_idx on public.estimate_holds (tenant_id, conversation_id);
