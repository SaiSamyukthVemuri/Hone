-- 0341: portal messages and replies are written by the application server only.
-- DRAFT until applied; hosted apply needs the owner's per-change approval.
--
-- SCOPE: public.client_portal_messages and public.client_portal_message_replies, and nothing else.
--
-- WHAT CHANGES
--   1. The three member write policies from 0055 are dropped:
--        client_portal_messages_studio_member_insert
--        client_portal_messages_studio_member_update
--        client_portal_message_replies_studio_member_update
--   2. INSERT and UPDATE on the two tables are revoked from anon and authenticated, so the result does not rest
--      on row level security alone.
--
-- WHAT DOES NOT CHANGE
--   The two member SELECT policies and every SELECT grant. service_role. Every other privilege of anon and
--   authenticated on these tables (no DELETE policy exists and none is added). PUBLIC holds nothing and is
--   granted nothing. No function, trigger, column, data or other table.
--
-- WHY NO APPLICATION PATH IS AFFECTED
--   Every application write to both tables goes through the server admin client after the server action has
--   resolved the actor and tenant from the session:
--     staff   app/(app)/clients/[id]/portal-messages-actions.ts
--               createPortalMessageAction, archivePortalMessageAction, markPortalReplySeenAction
--     client  app/portal/portal-message-actions.ts
--               markPortalMessageReviewedAction, createPortalMessageReplyAction
--   No SQL function, trigger or cron writes either table. Pinned by tests/security/portal-message-writers.test.ts.
--   Who may send stays decided in the server action.
--
-- ROLLBACK: supabase/rollbacks/0341_portal_message_member_write_policies.down.sql restores exactly the two
-- revoked privileges for anon and authenticated and the three 0055 policy definitions.

begin;

set local lock_timeout = '5s';

drop policy if exists "client_portal_messages_studio_member_insert" on public.client_portal_messages;
drop policy if exists "client_portal_messages_studio_member_update" on public.client_portal_messages;
drop policy if exists "client_portal_message_replies_studio_member_update" on public.client_portal_message_replies;

revoke insert, update on table public.client_portal_messages from anon, authenticated;
revoke insert, update on table public.client_portal_message_replies from anon, authenticated;

-- Closing assertions: RLS stays on, the member reads remain, no write policy is left, the API roles cannot
-- insert or update (has_table_privilege also counts anything held through PUBLIC), and service_role still can.
do $$
declare
  t text;
  r text;
  v_bad text;
begin
  foreach t in array array['client_portal_messages', 'client_portal_message_replies'] loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname = t) then
      raise exception '0341: row level security must stay enabled on public.%', t;
    end if;
    if not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = t
                    and policyname = t || '_studio_member_select' and cmd = 'SELECT') then
      raise exception '0341: %_studio_member_select must remain', t;
    end if;
    select string_agg(policyname || ' (' || cmd || ')', ', ' order by policyname) into v_bad
      from pg_catalog.pg_policies where schemaname = 'public' and tablename = t and cmd <> 'SELECT';
    if v_bad is not null then
      raise exception '0341: unexpected write policy on public.%: %', t, v_bad;
    end if;
    foreach r in array array['anon', 'authenticated'] loop
      if pg_catalog.has_table_privilege(r, 'public.' || t, 'INSERT')
         or pg_catalog.has_table_privilege(r, 'public.' || t, 'UPDATE') then
        raise exception '0341: % must not hold INSERT or UPDATE on public.%', r, t;
      end if;
    end loop;
    if not (pg_catalog.has_table_privilege('service_role', 'public.' || t, 'INSERT')
            and pg_catalog.has_table_privilege('service_role', 'public.' || t, 'UPDATE')) then
      raise exception '0341: service_role must keep INSERT and UPDATE on public.%', t;
    end if;
  end loop;
end $$;

commit;
