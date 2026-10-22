// LOCAL-ONLY synthetic Fett twin CLEANUP MANIFEST (#825 6156413624 §2).
//
// It inventories exactly what the twin owns (manifest ids, studios fett-twin / fett-twin-ca, auth users
// @fett-twin.synth.local) and reports it. It DELETES NOTHING once the twin holds financial or clinical
// history: appointment_settlements refuses deletion ("financial history is never deleted") and setup
// readings are immutable, and those guards are deliberately NOT bypassed (disabling triggers would also
// disable FK cascades and leave orphans). Removing a full twin is the guarded reset of its own isolated
// stack (scripts/fett-twin/reset.sh). A history-free twin (a failed partial seed) is removed when
// FETT_TWIN_CLEANUP=1; otherwise this is a dry run.
import { afterAll, it } from "vitest";
import { adminQuery, closePool, purgeAppointmentAudit } from "../db/helpers/harness";
import { IDS, TWIN } from "./fett-twin-manifest";
import { assertTwinTarget } from "./fett-twin-target";

assertTwinTarget();
afterAll(async () => closePool());

it("inventories (and, only if history-free, removes) the synthetic Fett twin", { timeout: 300_000 }, async () => {
  const studios = (await adminQuery(`select id, slug from public.studios where id = any($1::uuid[]) or slug = any($2::text[])`, [[IDS.studio, IDS.studioCa], [TWIN.slug, TWIN.slugCa]])).rows;
  const unowned = studios.filter((s) => s.id !== IDS.studio && s.id !== IDS.studioCa);
  if (unowned.length) {
    console.log(`[fett-twin cleanup] REFUSING: slug(s) ${unowned.map((s) => s.slug).join(", ")} belong to studios NOT owned by this manifest; nothing touched`);
    return;
  }
  const ids = studios.map((s) => s.id);
  const users = (await adminQuery(`select count(*)::int as n from auth.users where email like $1`, [`%${TWIN.domain}`])).rows[0].n;
  const h = ids.length
    ? (
        await adminQuery(
          `select (select count(*) from public.appointment_settlements where studio_id = any($1))::int as settlements,
                  (select count(*) from public.treatment_setup_readings where studio_id = any($1))::int as readings,
                  (select count(*) from public.payment_charge_attempts where studio_id = any($1))::int as charge_attempts`,
          [ids],
        )
      ).rows[0]
    : { settlements: 0, readings: 0, charge_attempts: 0 };
  console.log(`[fett-twin cleanup] owned studios: ${studios.map((s) => s.slug).join(", ") || "none"}; auth users: ${users}; history: ${JSON.stringify(h)}`);
  if (h.settlements + h.readings + h.charge_attempts > 0) {
    console.log("[fett-twin cleanup] immutable financial/clinical history present: NOT deleting. Remove it with scripts/fett-twin/reset.sh (guarded isolated reset)");
    return;
  }
  if (process.env.FETT_TWIN_CLEANUP !== "1") {
    console.log("[fett-twin cleanup] DRY RUN: set FETT_TWIN_CLEANUP=1 to remove this history-free twin");
    return;
  }
  for (const id of ids) {
    await purgeAppointmentAudit(id);
    await adminQuery(`delete from public.studios where id = $1`, [id]);
  }
  await adminQuery(`delete from auth.users where email like $1`, [`%${TWIN.domain}`]);
  console.log("[fett-twin cleanup] removed");
});
