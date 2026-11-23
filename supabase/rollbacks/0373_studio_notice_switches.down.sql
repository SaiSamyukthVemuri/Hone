-- Down for 0373. Drops the two studio notice switches. The saved choices are lost; after this, both client notices are sent
-- again for every studio (the behaviour before 0373). The application reads an absent setting as ON, so code that reads these
-- columns keeps working. Touches no other column. Run it only if 0373 must be undone.
begin;

set local lock_timeout = '5s';

alter table public.studios
  drop column if exists send_moved_appointment_emails,
  drop column if exists send_client_cancellation_emails;

commit;
