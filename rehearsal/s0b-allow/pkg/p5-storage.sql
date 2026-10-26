-- S0B (P5) PRE-RESTORE: storage object metadata per bucket (the files themselves are not in a database restore).
-- Bucket ids are application-defined names. Counts and byte totals only; no object name, no owner.
select o.bucket_id as bucket_id, count(*) as objects, coalesce(sum(nullif(o.metadata->>'size', '')::bigint), 0)::bigint as bytes
from storage.objects o
group by o.bucket_id
union all
select '(all buckets)', count(*), coalesce(sum(nullif(o.metadata->>'size', '')::bigint), 0)::bigint from storage.objects o
order by 1;
