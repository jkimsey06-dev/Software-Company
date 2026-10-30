-- Fake seed data for local/dev only. Never put real customer data here.
-- Numbers use the 555-01xx fictional range.

insert into public.tenants (id, slug, name, config) values
  ('10000000-0000-0000-0000-000000000001', 'example-hvac', 'Example Heating & Air', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.leads (tenant_id, phone, name, service_id, area, urgency, source) values
  ('10000000-0000-0000-0000-000000000001', '+14235550111', 'Test Customer One', 'ac-repair', 'Cleveland', 'emergency', 'missed_call'),
  ('10000000-0000-0000-0000-000000000001', '+14235550112', 'Test Customer Two', 'maintenance', 'Ooltewah', 'flexible', 'missed_call'),
  ('10000000-0000-0000-0000-000000000001', '+14235550113', null, null, null, 'unknown', 'web_form');
