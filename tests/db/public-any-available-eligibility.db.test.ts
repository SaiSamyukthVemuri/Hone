import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool } from "./helpers/harness";
import {
  FETT_DEMO_SLOT_SQL,
  dropFettStudio,
  seedFettStudio,
  type FettStudio,
} from "./helpers/fett-fixture";

// CODEX P2 4264153695. "Any available" is the DEFAULT choice, and on a
// capacity-booking-enabled studio whose sole active owner is NOT pinned to the
// service it used to fall through to the legacy owner path -- so the command
// picked the owner, the validator answered `not_eligible`, and the default
// booking path failed EVERY time while the page advertised eligible
// practitioners and showed a grid.
//
// Resolution now goes through resolve_public_any_available_practitioner, which
// offers each eligible candidate to validate_public_booking_slot_v2 -- the same
// authority that re-validates the winner at the transaction boundary.
// db-integration lane, real migrated schema.

afterAll(async () => {
  await closePool();
});

const tok = () => randomBytes(32).toString("hex");

async function setAdmissionOpen(fett: FettStudio) {
  const r = await asUser(fett.userId, (q) =>
    q(`select * from public.set_new_client_admission_mode($1, $2)`, [fett.studioId, "open"]),
  );
  expect(r.rows[0]?.outcome).toBe("ok");
}

/** Pin ONLY the given practitioners to the service, leaving the owner off it. */
async function pinOnly(fett: FettStudio, practitionerIds: string[]) {
  await adminQuery(`delete from public.service_practitioners where service_id = $1`, [
    fett.services.treatmentId,
  ]);
  for (const id of practitionerIds) {
    await adminQuery(
      `insert into public.service_practitioners (studio_id, service_id, practitioner_id)
       values ($1, $2, $3) on conflict do nothing`,
      [fett.studioId, fett.services.treatmentId, id],
    );
  }
  // The premise, asserted rather than assumed: the owner must be OFF the list,
  // or this suite proves nothing about the defect.
  const owner = await adminQuery(
    `select exists (
       select 1 from public.service_practitioners sp
        where sp.service_id = $1 and sp.practitioner_id = $2) as on_list`,
    [fett.services.treatmentId, fett.practitioners[0]!.practitionerId],
  );
  expect(owner.rows[0].on_list, "the OWNER must be unpinned for this scenario").toBe(false);
}

/** Pin the given practitioners WITHOUT asserting the owner is absent. */
async function pinOnlyAllowingOwner(fett: FettStudio, practitionerIds: string[]) {
  await adminQuery(`delete from public.service_practitioners where service_id = $1`, [
    fett.services.treatmentId,
  ]);
  for (const id of practitionerIds) {
    await adminQuery(
      `insert into public.service_practitioners (studio_id, service_id, practitioner_id)
       values ($1, $2, $3) on conflict do nothing`,
      [fett.studioId, fett.services.treatmentId, id],
    );
  }
}

async function bookAnyAvailable(fett: FettStudio, startsAtSql = FETT_DEMO_SLOT_SQL) {
  const email = `g1-any-${randomUUID().slice(0, 8)}@synth.local`;
  const r = await adminQuery(
    `select * from public.create_public_appointment_for_new_client_v2(
       $1, null, $2, $3, null, null, $4, ${startsAtSql}, $5, false, null, null, null, null)`,
    [fett.studioId, `SYNTH-FETT any ${email.slice(0, 10)}`, email, fett.services.treatmentId, tok()],
  );
  return {
    row: r.rows[0] as {
      result: string;
      appointment_id: string | null;
      practitioner_id: string | null;
      client_id: string | null;
    },
    email,
  };
}

async function clientCount(studioId: string, email: string) {
  const c = await adminQuery(
    `select count(*)::int as n from public.clients
      where studio_id = $1 and normalized_email = lower(btrim($2))`,
    [studioId, email],
  );
  return c.rows[0].n as number;
}

describe("G1: Any available resolves to an ELIGIBLE practitioner", () => {
  it("OWNER UNPINNED, two eligible (one busy, one free): books the FREE one", async () => {
    const fett = await seedFettStudio({ treatingCount: 2, capacity: "live" });
    try {
      await setAdmissionOpen(fett);
      const a = fett.practitioners[1]!.practitionerId;
      const b = fett.practitioners[2]!.practitionerId;
      await pinOnly(fett, [a, b]);

      // Make `a` busy at the instant, so the only correct answer is `b`.
      // Through the real internal command, not a hand-written row.
      const busy = await adminQuery(
        `select * from public.create_internal_appointment_v2(
           $1, $2, $3, $4, ${FETT_DEMO_SLOT_SQL}, null, null)`,
        [fett.studioId, fett.userId, fett.clientId, fett.services.treatmentId],
      ).catch(() => null);
      if (!busy || busy.rows[0]?.result !== "created") {
        // The internal command's signature differs across chains; fall back to
        // occupying `a` via the public v2 command, which is in this lane.
        const occupy = await adminQuery(
          `select * from public.create_public_appointment_v2(
             $1, $2, $3, ${FETT_DEMO_SLOT_SQL}, $4, null, null, $5)`,
          [fett.studioId, fett.clientId, fett.services.treatmentId, tok(), a],
        );
        expect(occupy.rows[0].result, "the busy fixture must actually book").toBe("created");
      }

      const r = await bookAnyAvailable(fett);
      expect(r.row.result).toBe("created");
      expect(
        r.row.practitioner_id,
        "Any available must resolve to the FREE eligible practitioner, never the unpinned owner",
      ).toBe(b);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("ALL ELIGIBLE UNAVAILABLE: refused, and NO client row is written", async () => {
    const fett = await seedFettStudio({ treatingCount: 1, capacity: "live" });
    try {
      await setAdmissionOpen(fett);
      const a = fett.practitioners[1]!.practitionerId;
      await pinOnly(fett, [a]);
      // Occupy the only eligible practitioner at the instant.
      const occupy = await adminQuery(
        `select * from public.create_public_appointment_v2(
           $1, $2, $3, ${FETT_DEMO_SLOT_SQL}, $4, null, null, $5)`,
        [fett.studioId, fett.clientId, fett.services.treatmentId, tok(), a],
      );
      expect(occupy.rows[0].result).toBe("created");

      const r = await bookAnyAvailable(fett);
      expect(r.row.result).toBe("no_practitioner_available");
      expect(r.row.appointment_id).toBeNull();
      expect(r.row.client_id, "refused before the client exists").toBeNull();
      expect(
        await clientCount(fett.studioId, r.email),
        "a refusal must not leave a partial client row",
      ).toBe(0);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("EXPLICIT selection still wins, and an unpinned owner is still refused", async () => {
    const fett = await seedFettStudio({ treatingCount: 2, capacity: "live" });
    try {
      await setAdmissionOpen(fett);
      const a = fett.practitioners[1]!.practitionerId;
      const b = fett.practitioners[2]!.practitionerId;
      await pinOnly(fett, [a, b]);
      const email = `g1-exp-${randomUUID().slice(0, 8)}@synth.local`;
      const chosen = await adminQuery(
        `select * from public.create_public_appointment_for_new_client_v2(
           $1, null, $2, $3, null, null, $4, ${FETT_DEMO_SLOT_SQL}, $5, false, null, null, null, $6)`,
        [fett.studioId, "SYNTH-FETT explicit", email, fett.services.treatmentId, tok(), b],
      );
      expect(chosen.rows[0].result).toBe("created");
      expect(chosen.rows[0].practitioner_id, "an explicit choice is honoured verbatim").toBe(b);

      // And the unpinned OWNER, named explicitly, is still refused by eligibility.
      const owner = fett.practitioners[0]!.practitionerId;
      const email2 = `g1-own-${randomUUID().slice(0, 8)}@synth.local`;
      const refused = await adminQuery(
        `select * from public.create_public_appointment_for_new_client_v2(
           $1, null, $2, $3, null, null, $4, ${FETT_DEMO_SLOT_SQL} + interval '1 hour', $5, false, null, null, null, $6)`,
        [fett.studioId, "SYNTH-FETT owner", email2, fett.services.treatmentId, tok(), owner],
      );
      expect(refused.rows[0].result).toBe("not_eligible");
      expect(await clientCount(fett.studioId, email2)).toBe(0);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("LEGACY (booking flag OFF): the owner path and the LEGACY validator still decide", async () => {
    // THE GUARD THAT MATTERS MOST, and my first version of it asserted the
    // wrong thing. I expected legacy + unpinned owner to book, and it returns
    // `not_eligible`. I checked that against the PRE-CHANGE bytes before
    // touching anything: they return `not_eligible` too, so this is existing
    // behaviour of the legacy validator, which honours service eligibility in
    // BOTH capacity modes (0170), and not a regression from this change.
    //
    // It is deliberately NOT "fixed" here. Codex's instruction is to preserve
    // flag-off/NULL behaviour exactly, and a legacy studio is never offered the
    // picker, so resolving on its behalf would be inventing a product change on
    // a path nobody asked me to alter.
    const fett = await seedFettStudio({ treatingCount: 2, capacity: "legacy" });
    try {
      await setAdmissionOpen(fett);
      const owner = fett.practitioners[0]!.practitionerId;

      // 1. The NORMAL legacy shape -- owner pinned -- still books through the
      //    owner path, which is what "legacy is unchanged" has to mean.
      await pinOnlyAllowingOwner(fett, [owner]);
      const ok = await bookAnyAvailable(fett);
      expect(ok.row.result, "legacy NULL booking must still work").toBe("created");
      expect(ok.row.practitioner_id, "and must still resolve to the owner").toBe(owner);

      // 2. Owner unpinned: refused, EXACTLY as the unchanged bytes refuse. No
      //    resolution happens, because v_booking_on is false.
      await pinOnly(fett, [fett.practitioners[1]!.practitionerId]);
      const refused = await bookAnyAvailable(fett);
      expect(
        refused.row.result,
        "pre-existing legacy behaviour, verified against the pre-change bytes",
      ).toBe("not_eligible");
      expect(
        refused.row.practitioner_id,
        "and legacy must NOT have resolved an alternative",
      ).toBeNull();
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("CONCURRENT callers cannot both take the only free eligible practitioner", async () => {
    // The appointment writers serialise on the studio capacity advisory lock
    // the command itself acquires, so two "Any available" requests for the same
    // instant must not both resolve to the same person.
    const fett = await seedFettStudio({ treatingCount: 1, capacity: "live" });
    try {
      await setAdmissionOpen(fett);
      await pinOnly(fett, [fett.practitioners[1]!.practitionerId]);
      const [first, second] = await Promise.all([
        bookAnyAvailable(fett),
        bookAnyAvailable(fett),
      ]);
      const results = [first.row.result, second.row.result].sort();
      expect(
        results,
        "exactly one must win; the other must be refused, not double-booked",
      ).toEqual(["created", "no_practitioner_available"]);
      const appts = await adminQuery(
        `select count(*)::int as n from public.appointments where studio_id = $1`,
        [fett.studioId],
      );
      expect(appts.rows[0].n, "one appointment, not two").toBe(1);
    } finally {
      await dropFettStudio(fett);
    }
  });
});
