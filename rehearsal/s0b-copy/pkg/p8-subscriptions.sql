-- S0B (P8) logical replication: subscriptions (cluster wide) and publications. The platform realtime publication is counted apart. Counts only.
select (select count(*) from pg_subscription) as subscriptions,
  (select count(*) from pg_publication) as publications_all,
  (select count(*) from pg_publication p where p.pubname <> 'supabase_realtime') as publications_other;
