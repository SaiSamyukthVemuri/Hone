-- 0255 VALIDATE (operator step, run only after the preflight counts are READ).
--
-- Validates each 0255 form CHECK whose violating-row count is ZERO right now,
-- and leaves a constraint with violating rows NOT VALID with a warning (never
-- an abort, never a deletion). Validation removes the two NOT VALID hazards: a
-- legacy row that cannot be updated (admin "mark contacted") and one that
-- aborts a logical restore load. Idempotent: re-running revalidates nothing
-- that is already valid. Not part of the migration chain.
begin;
set local lock_timeout = '5s';

do $$
declare
  v_row record;
  v_n pg_catalog.int8;
begin
  for v_row in
    select * from (values
    ('public.waitlist', 'waitlist_email_format_chk', $c$char_length(email) between 3 and 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'$c$),
    ('public.waitlist', 'waitlist_field_length_chk', $c$char_length(practice_name) <= 300 and char_length(source) <= 40$c$),
    ('public.demo_requests', 'demo_requests_email_format_chk', $c$char_length(email) between 3 and 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'$c$),
    ('public.demo_requests', 'demo_requests_field_length_chk', $c$char_length(name) between 1 and 200
      and char_length(practice_name) <= 300
      and char_length(location) <= 300
      and char_length(current_tool) <= 300
      and char_length(notes) <= 5000
      and char_length(status) <= 40$c$)
    ) as t(tbl, con, expr)
  loop
    execute pg_catalog.format('select pg_catalog.count(*) from %s where (%s) is false', v_row.tbl, v_row.expr)
      into v_n;
    if v_n = 0 then
      execute pg_catalog.format('alter table %s validate constraint %I', v_row.tbl, v_row.con);
      raise notice '0255 validate: % validated', v_row.con;
    else
      raise warning '0255 validate: % left NOT VALID, % violating row(s)', v_row.con, v_n;
    end if;
  end loop;
end;
$$;

commit;
