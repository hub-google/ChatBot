-- Supabase pg_cron (30-second ticks) + pg_net; no Cloudflare Worker.
-- HTTP requests are only made while unfinished work exists.
-- The worker authentication secret stays inside Supabase Vault, never in Git.
SELECT cron.schedule(
  'chatbot-line-retry',
  '30 seconds',
  $job$
  -- A crashed function may have already sent the LINE message.
  -- Never blindly re-send an ambiguous delivery.
  UPDATE public."ChatBot_Line_pending"
  SET status='uncertain',error_code='line_send_interrupted',updated_at=now()
  WHERE status='sending' AND updated_at<now()-interval '3 minutes';
  SELECT net.http_post(
    url := 'https://unapiwajmgqqtdkixaab.supabase.co/functions/v1/line-ai-chatbot',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-chatbot-worker',(
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name='chatbot_line_scheduler_key' LIMIT 1
      )
    ),
    body := '{"worker":true}'::jsonb,
    timeout_milliseconds := 5000
  )
  WHERE EXISTS (
    SELECT 1 FROM public."ChatBot_Line_pending"
    WHERE (status='pending' AND next_retry_at<=now())
       OR (status='processing' AND leased_until<now())
  );
  $job$
);
