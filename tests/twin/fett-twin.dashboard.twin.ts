// LOCAL-ONLY additive presentation data for the existing Fett twin.
// Run with the SAME guarded target/env and vitest config as fett-twin.seed.twin.ts.
// No reset: preserve Sam's bookings, notes, intakes, selections and recorded readings.
// This is synthetic fixture data, not a provider send or a clinical acceptance receipt.
import { createHash } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { adminQuery, closePool } from "../db/helpers/harness";
import { EMAILS, IDS, TWIN, twinId, validateTwin } from "./fett-twin-manifest";
import { assertTwinTarget } from "./fett-twin-target";

const target = assertTwinTarget();
const MARKER = "Synthetic demo appointment (dashboard enrichment).";
afterAll(closePool);

it("enriches the owned twin dashboard without resetting existing work", { timeout: 120_000 }, async () => {
  // Validate BOTH endpoint configuration and the pre-existing ownership manifest.
  // scripts/fett-twin/reset.sh's physical project/container proof is still required
  // before execution; this file never starts or resets a stack.
  expect(target.apiUrl).toBeTruthy();
  const verdict = await validateTwin();
  if (verdict.state !== "verified") {
    throw new Error("Dashboard enrichment needs the verified existing twin; seed it through the guarded runner first.");
  }

  const people = (await adminQuery(
    `select id, email from public.practitioners where studio_id = $1 and active
       and (email = $2 or email = any($3::text[]))`,
    [IDS.studio, EMAILS.owner, Array.from({ length: TWIN.treatingCount }, (_, i) => EMAILS.treating(i + 1))],
  )).rows as Array<{ id: string; email: string }>;
  const owner = people.find((p) => p.email === EMAILS.owner);
  const treating = Array.from({ length: TWIN.treatingCount }, (_, i) =>
    people.find((p) => p.email === EMAILS.treating(i + 1)),
  );
  if (!owner || treating.some((p) => !p)) throw new Error("The twin's original practitioners are incomplete.");

  // Today's roster, plus the next working day. Dates are evaluated in LA,
  // not the host timezone. Future slots use the real internal-booking command;
  // elapsed slots and genuine conflicts are preserved/skipped, never fabricated.
  // Include the owner so the presenter can exercise their OWN future chart.
  const roster = [owner, ...treating.filter((p): p is NonNullable<typeof p> => !!p)];
  const dates = (await adminQuery(
    `select (now() at time zone $1)::date::text as today,
       (select d::date::text from generate_series(
          (now() at time zone $1)::date + 1,
          (now() at time zone $1)::date + 7, interval '1 day') d
        where extract(isodow from d) between 1 and 5 order by d limit 1) as next_day`,
    [TWIN.timezone],
  )).rows[0] as { today: string; next_day: string };
  const visibleToday = async () => Number((await adminQuery(
    `select count(*)::int as n from public.appointments where studio_id = $1
       and (starts_at at time zone $2)::date = (now() at time zone $2)::date
       and status <> 'cancelled'`,
    [IDS.studio, TWIN.timezone],
  )).rows[0].n);
  const clock = (await adminQuery(
    `select extract(isodow from (now() at time zone $1))::int between 1 and 5
       and (now() at time zone $1)::time < time '16:30' as can_book_today`,
    [TWIN.timezone],
  )).rows[0] as { can_book_today: boolean };
  if (!(await visibleToday()) && !clock.can_book_today) {
    throw new Error("No visible roster today and no remaining opening-hours slot. No enrichment was written.");
  }
  const created: string[] = [];
  const skipped: string[] = [];
  for (const day of [dates.today, dates.next_day]) {
    for (const [personIndex, person] of roster.entries()) {
      for (const [slotIndex, time] of ["09:00", "10:30", "12:00", "13:30", "15:00", "16:00", "16:30"].entries()) {
        const clientId = IDS.client(((personIndex * 2 + slotIndex) % TWIN.clientCount) + 1);
        const instant = (await adminQuery(
          `select (($1::date + $2::time) at time zone $3) as starts_at,
             (($1::date + $2::time) at time zone $3) > now() as upcoming`,
          [day, time, TWIN.timezone],
        )).rows[0] as { starts_at: Date | string; upcoming: boolean };
        if (!instant.upcoming) continue;
        // This also preserves a presenter's edit to an enrichment appointment.
        const tokenHash = createHash("sha256").update(
          `fett-dashboard/${day}/${person.id}/${time}`,
        ).digest("hex");
        const existing = (await adminQuery(
          `select id from public.appointments where studio_id = $1 and cancellation_token_hash = $2`,
          [IDS.studio, tokenHash],
        )).rows[0];
        if (existing) continue;
        try {
          const result = (await adminQuery(
            `select * from public.create_internal_appointment_v2(
              $1, $2, $3, $4, $5, $6, $7, $8, null, false)`,
            [IDS.studio, owner.id, person.id, clientId,
              slotIndex === 0 || time === "16:30" ? IDS.consult : IDS.treatment, instant.starts_at, tokenHash, MARKER],
          )).rows[0] as { result: string; appointment_id: string | null };
          if (result.result === "created" && result.appointment_id) created.push(result.appointment_id);
          else skipped.push(`${day} ${time}: ${result.result}`);
        } catch (error) {
          // Only the known overlap constraint is a benign presentation conflict.
          // Schema, privilege or other failures must remain failures.
          if ((error as { code?: string }).code !== "23P01") throw error;
          skipped.push(`${day} ${time}: existing practitioner booking`);
        }
      }
    }
    // Prove today's visible roster before adding next-day bookings or other
    // presentation data. Refused bookings and preserved cancellations cannot
    // leave unrelated enrichment behind.
    if (day === dates.today && !(await visibleToday())) {
      throw new Error("No visible appointments could be created today. No next-day or dashboard enrichment was written.");
    }
  }

  // Existing dashboard reads these real domain tables; no disconnected UI cards.
  // Only fill absent fixture fields/rows. Never replace a presenter's edits.
  const notes = [
    "SYNTHETIC: prefers a quiet morning appointment; confirm comfort breaks.",
    "SYNTHETIC: discuss the next visit plan before starting treatment.",
    "SYNTHETIC: intake is in progress; complete it together before treatment.",
    "SYNTHETIC: review the submitted intake before the consultation.",
    "SYNTHETIC: check aftercare questions and agree the next booking.",
    "SYNTHETIC: allow extra time for the first consultation.",
  ];
  for (const [index, text] of notes.entries()) {
    const clientId = IDS.client(index + 1);
    await adminQuery(
      `insert into public.client_pinned_notes
         (id, studio_id, client_id, text, created_by_practitioner_id)
       values ($1, $2, $3, $4, $5) on conflict (id) do nothing`,
      [twinId(`dashboard:pinned-note:${index + 1}`), IDS.studio, clientId, text, owner.id],
    );
  }

  // One fixed month/day-only birthday in EVERY month. Dates do not roll with
  // the clock, and a presenter's date is never replaced. 1900 is the product's
  // canonical sentinel for an unknown birth year.
  for (let index = 1; index <= TWIN.clientCount; index += 1) {
    await adminQuery(
      `update public.clients set date_of_birth = make_date(1900, $3, $4)
       where id = $1 and studio_id = $2 and date_of_birth is null`,
      [IDS.client(index), IDS.studio, index, 9 + index],
    );
  }

  // Mirror the existing E2E intake fixture. These are explicitly synthetic,
  // partial answers: no consent/acknowledgement, signature, review or send
  // is invented. The real review page must continue to expose missing answers.
  for (const [clientIndex, status] of [[3, "in_progress"], [4, "submitted"], [6, "in_progress"]] as const) {
    await adminQuery(
      `insert into public.client_intake_forms
         (id, studio_id, client_id, status, responses, submitted_at)
       select $1, $2, $3, $4, '{"has_allergies":"no"}'::jsonb,
              case when $4 = 'submitted' then now() else null end
       where not exists (
         select 1 from public.client_intake_forms
          where studio_id = $2 and client_id = $3 and deleted_at is null)
       on conflict (id) do nothing`,
      [twinId(`dashboard:intake:${clientIndex}`), IDS.studio, IDS.client(clientIndex), status],
    );
  }

  // Fix the original fixture's misleading location-as-machine labels. Stable
  // physical IDs, retired units, reading snapshots and practitioner defaults
  // are untouched. Exact old seed labels only; preserve any presenter rename.
  await adminQuery(
    `update public.studio_machines
       set display_name = case display_name
         when 'Room 1 demo' then 'SYNTH Galvanic 01'
         when 'Room 3 single-probe demo' then 'SYNTH Blend 01' end
     where studio_id = $1 and retired_at is null and machine_profile_id like 'synthetic:%'
       and display_name in ('Room 1 demo', 'Room 3 single-probe demo')
       and not exists (
         select 1 from public.studio_machines other
          where other.studio_id = $1 and other.id <> studio_machines.id
            and lower(btrim(other.display_name)) = lower(case studio_machines.display_name
              when 'Room 1 demo' then 'SYNTH Galvanic 01'
              when 'Room 3 single-probe demo' then 'SYNTH Blend 01' end))`,
    [IDS.studio],
  );

  const facts = (await adminQuery(
    `select
       (select count(*)::int from public.appointments where studio_id = $1
          and (starts_at at time zone $2)::date = (now() at time zone $2)::date
          and status <> 'cancelled') as today,
       (select count(*)::int from public.client_pinned_notes where studio_id = $1) as pinned_notes,
       (select count(*)::int from public.client_intake_forms where studio_id = $1 and deleted_at is null) as intakes,
       (select count(*)::int from public.clients where studio_id = $1
          and extract(month from date_of_birth) = extract(month from (now() at time zone $2))) as birthdays`,
    [IDS.studio, TWIN.timezone],
  )).rows[0] as { today: number; pinned_notes: number; intakes: number; birthdays: number };
  expect(facts.today, "The presenter dashboard still has no appointments today").toBeGreaterThan(0);
  expect(facts.pinned_notes).toBeGreaterThanOrEqual(6);
  expect(facts.intakes).toBeGreaterThanOrEqual(3);
  expect(facts.birthdays).toBeGreaterThanOrEqual(1);
  expect((await validateTwin()).state).toBe("verified");
  // No emails, tokens or links in the receipt.
  console.log(JSON.stringify({ event: "fett_dashboard_enriched", created: created.length, skipped, facts }));
});

