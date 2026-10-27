-- S0B (P2) PRE-RESTORE: queued and stored outbound HTTP requests (pg_net). Run only if p0 says both tables exist. Counts only.
select
  (select count(*) from net.http_request_queue) as queued_requests,
  (select count(*) from net._http_response)     as stored_responses;
