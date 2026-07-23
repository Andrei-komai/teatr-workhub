grant select on table public.calendar_events to service_role;
grant select on table public.schedule_entries to service_role;
grant select on table public.notification_preferences to service_role;
grant select, delete on table public.push_subscriptions to service_role;
grant select, insert, delete on table public.notification_deliveries to service_role;
