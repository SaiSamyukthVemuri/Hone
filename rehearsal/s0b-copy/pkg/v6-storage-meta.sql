-- S0B (V6) storage object METADATA created at or before T (the files themselves are not part of a database restore).
-- T is the one placeholder. Count and byte total only; no object name, no owner.
with p as (select '@@T@@'::timestamptz as t)
select count(*) as objects_le_t, coalesce(sum(nullif(o.metadata->>'size', '')::bigint), 0)::bigint as bytes_le_t
from storage.objects o cross join p
where o.created_at <= p.t;
