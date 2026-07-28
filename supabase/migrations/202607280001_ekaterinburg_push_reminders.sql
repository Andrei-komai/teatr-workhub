alter table public.notification_preferences
  alter column reminder_minutes set default 60;

update public.notification_preferences
set reminder_minutes = 60,
    updated_at = now()
where reminder_minutes <> 60;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'push-reminders-every-minute') then
    perform cron.unschedule('push-reminders-every-minute');
  end if;

  perform cron.schedule(
    'push-reminders-every-minute',
    '* * * * *',
    $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'push_project_url') || '/functions/v1/push-reminders',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret')
        ),
        body := '{}'::jsonb
      );
    $job$
  );
end
$$;
