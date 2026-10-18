import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import {
  FETT_DEMO_SLOT_SQL,
  dropFettStudio,
  seedFettStudio,
  setFettCapacityState,
  type FettStudio,
} from "./helpers/fett-fixture";

// Proves 0222 (the G1 write side) instead of asserting it.
//
// 0219 made a practitioner pickable; 0222 makes the pick REAL. Without it the
// page would offer a practitioner while create_public_appointment still
// assigned by the active-owner count (0170:790-808) — the client chooses
// someone and is booked with the owner.
//
// The load-bearing pair is again LIVE vs LEGACY: under LIVE two clients must be
// able to take the SAME instant with DIFFERENT practitioners through the PUBLIC
// command; under LEGACY the second must be refused, because every reservation
// is keyed to the studio. And the NULL path must reproduce 0170 exactly, or
// adopting v2 would be a silent behaviour change for every existing caller.
// db-integration lane, real migrated schema (chain 0211-0222).

afterAll(async () => {
  await closePool();
});

const tok = () => randomBytes(32).toString("hex");

async function bookPublicV2(
  fett: FettStudio,
  practitionerId: string | null,
  clientId?: string,
) {
  const r = await adminQuery(
    `select * from public.create_public_appointment_v2(
       $1, $2, $3, ${FETT_DEMO_SLOT_SQL}, $4, null, null, $5)`,
    [
      fett.studioId,
      clientId ?? fett.clientId,
      fett.services.treatmentId,
      tok(),
      practitionerId,
    ],
  );
  return r.rows[0] as {
    result: string;
    appointment_id: string | null;
    practitioner_id: string | null;
    starts_at: Date | null;
  };
}

async function bookPublicV1(fett: FettStudio) {
  const r = await adminQuery(
    `select * from public.create_public_appointment(
       $1, $2, $3, ${FETT_DEMO_SLOT_SQL}, $4, null, null)`,
    [fett.studioId, fett.clientId, fett.services.treatmentId, tok()],
  );
  return r.rows[0] as { result: string; practitioner_id: string | null };
}

async function seedClient(studioId: string, name: string) {
  const r = await adminQuery(
    `insert into public.clients (studio_id, name) values ($1, $2) returning id`,
    [studioId, name],
  );
  return r.rows[0].id as string;
}

describe("0222 — a chosen practitioner is honoured", () => {
  it("books the NAMED practitioner, not the owner", async () => {
    const fett = await seedFettStudio({ treatingCount: 2 });
    try {
      const chosen = fett.treating[1].practitionerId;
      const res = await bookPublicV2(fett, chosen);
      expect(res.result).toBe("created");
      expect(res.practitioner_id).toBe(chosen);
      // And it is NOT the owner — the whole point of G1.
      expect(res.practitioner_id).not.toBe(fett.practitionerId);
      const row = await adminQuery(
        `select practitioner_id from public.appointments where id = $1`,
        [res.appointment_id],
      );
      expect(row.rows[0].practitioner_id).toBe(chosen);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("NULL reproduces 0170 exactly — the same assignment as v1", async () => {
    // EQUIVALENCE CONTROL. If this diverged, pointing the route at v2 would be a
    // silent behaviour change for every existing public booking.
    const a = await seedFettStudio({ treatingCount: 2 });
    const b = await seedFettStudio({ treatingCount: 2 });
    try {
      const viaV1 = await bookPublicV1(a);
      const viaV2 = await bookPublicV2(b, null);
      expect(viaV1.result).toBe("created");
      expect(viaV2.result).toBe("created");
      // Both studios have exactly one active owner, so both must assign it.
      expect(viaV1.practitioner_id).toBe(a.practitionerId);
      expect(viaV2.practitioner_id).toBe(b.practitionerId);
    } finally {
      await dropFettStudio(a);
      await dropFettStudio(b);
    }
  });
});

describe("0222 — a practitioner is validated before it is trusted", () => {
  it("refuses another studio's practitioner, an inactive one, and a stranger", async () => {
    const a = await seedFettStudio({ treatingCount: 1 });
    const b = await seedFettStudio({ treatingCount: 1 });
    try {
      // Cross-tenant: B's practitioner must not be bookable in A.
      const cross = await bookPublicV2(a, b.treating[0].practitionerId);
      expect(cross.result).toBe("invalid_practitioner");
      expect(cross.appointment_id).toBeNull();

      const stranger = await bookPublicV2(
        a,
        "00000000-0000-0000-0000-000000000000",
      );
      expect(stranger.result).toBe("invalid_practitioner");

      await adminQuery(
        `update public.practitioners set active = false where id = $1`,
        [a.treating[0].practitionerId],
      );
      const inactive = await bookPublicV2(a, a.treating[0].practitionerId);
      expect(inactive.result).toBe("invalid_practitioner");

      // Nothing was written by any refusal.
      expect(
        Number(
          (
            await adminQuery(
              `select count(*) n from public.appointments where studio_id = $1`,
              [a.studioId],
            )
          ).rows[0].n,
        ),
      ).toBe(0);
    } finally {
      await dropFettStudio(a);
      await dropFettStudio(b);
    }
  });

  it("cannot book a receptionist, where one exists", async () => {
    const fett = await seedFettStudio({ treatingCount: 1 });
    try {
      if (!fett.receptionist) return; // 0210 chain: nothing to try
      const res = await bookPublicV2(fett, fett.receptionist.receptionistId);
      expect(res.result).toBe("invalid_practitioner");
    } finally {
      await dropFettStudio(fett);
    }
  });
});

describe("0222 — the capacity model decides whether a pick buys parallelism", () => {
  it("LIVE: two clients take the SAME instant with DIFFERENT practitioners", async () => {
    // THE G1 PAYOFF, through the PUBLIC command.
    const fett = await seedFettStudio({ treatingCount: 2 });
    try {
      const c2 = await seedClient(fett.studioId, "SYNTH-FETT client 2");
      const first = await bookPublicV2(fett, fett.treating[0].practitionerId);
      const second = await bookPublicV2(fett, fett.treating[1].practitionerId, c2);
      expect(first.result).toBe("created");
      expect(second.result).toBe("created");
      expect(second.starts_at!.getTime()).toBe(first.starts_at!.getTime());
      expect(second.practitioner_id).not.toBe(first.practitioner_id);
      expect(
        Number(
          (
            await adminQuery(
              `select count(distinct practitioner_id) n
                 from public.appointments where studio_id = $1`,
              [fett.studioId],
            )
          ).rows[0].n,
        ),
      ).toBe(2);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("LEGACY: the second is REFUSED, because the studio is one resource", async () => {
    // THE CONTROL. Without it the LIVE case could pass on a command that never
    // checked availability at all.
    const fett = await seedFettStudio({ treatingCount: 2, capacity: "legacy" });
    try {
      const c2 = await seedClient(fett.studioId, "SYNTH-FETT client 2");
      const first = await bookPublicV2(fett, fett.treating[0].practitionerId);
      expect(first.result).toBe("created");
      const second = await bookPublicV2(fett, fett.treating[1].practitionerId, c2);
      expect(second.result).not.toBe("created");
      expect(second.appointment_id).toBeNull();
      expect(
        Number(
          (
            await adminQuery(
              `select count(*) n from public.appointments where studio_id = $1`,
              [fett.studioId],
            )
          ).rows[0].n,
        ),
      ).toBe(1);
    } finally {
      await dropFettStudio(fett);
    }
  });
});

describe("0222 — scoping must NOT loosen anything", () => {
  it("SAME practitioner, same instant: the second booking is REFUSED", async () => {
    // THE SAFETY PROPERTY. Narrowing the conflict scope to one practitioner is
    // only correct if that practitioner is still protected against themselves.
    // If this ever passes, 0222 has turned a double-booking guard into a
    // double-booking feature.
    const fett = await seedFettStudio({ treatingCount: 2 });
    try {
      const p1 = fett.treating[0].practitionerId;
      const c2 = await seedClient(fett.studioId, "SYNTH-FETT client 2");
      const first = await bookPublicV2(fett, p1);
      expect(first.result).toBe("created");
      const second = await bookPublicV2(fett, p1, c2);
      expect(second.result).not.toBe("created");
      expect(second.appointment_id).toBeNull();
      expect(
        Number(
          (
            await adminQuery(
              `select count(*) n from public.appointments
                where studio_id = $1 and practitioner_id = $2`,
              [fett.studioId, p1],
            )
          ).rows[0].n,
        ),
      ).toBe(1);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("a studio-wide BLOCKOUT still closes the day for a chosen practitioner", async () => {
    // A SHARED CONSTRAINT THAT GENUINELY APPLIES. studio_blockouts has no
    // practitioner column — it is studio-wide by schema — so scoping must not
    // let a named practitioner book through it.
    //
    // The blockout is created BEFORE any booking: its shadow reservation
    // occupies the day, so inserting one over an existing appointment is
    // correctly refused by no_overlapping_calendar_reservations_per_resource.
    // Studio B is the control, identical but unblocked, so the refusal in A
    // cannot be mistaken for the slot being unbookable in general.
    const blocked = await seedFettStudio({ treatingCount: 1 });
    const control = await seedFettStudio({ treatingCount: 1 });
    try {
      const day = (
        await adminQuery(
          `select (${FETT_DEMO_SLOT_SQL} at time zone 'America/Los_Angeles')::date d`,
        )
      ).rows[0].d;
      await adminQuery(
        `insert into public.studio_blockouts (studio_id, starts_on, ends_on, reason)
         values ($1, $2, $2, 'SYNTH-FETT blockout')`,
        [blocked.studioId, day],
      );

      const refused = await bookPublicV2(blocked, blocked.treating[0].practitionerId);
      expect(refused.result).not.toBe("created");
      expect(refused.appointment_id).toBeNull();

      // CONTROL: the same instant, same shape, no blockout.
      const allowed = await bookPublicV2(control, control.treating[0].practitionerId);
      expect(allowed.result).toBe("created");
    } finally {
      await dropFettStudio(blocked);
      await dropFettStudio(control);
    }
  });

  it("LEGACY + a retained scoped row: the STUDIO-WIDE window governs", async () => {
    // CHANGE 2's hazard, on the write path. A scoped availability row can only
    // be INSERTED while capacity is ON (0134's guard), and it is RETAINED
    // across a capacity rollback BY DESIGN. If the validator preferred it
    // unconditionally, a stale 10:00-12:00 row would decide a capacity-OFF
    // studio's public window and refuse slots the studio-wide page offers.
    //
    // The demo slot is 10:00, inside both windows, so the proof is that a
    // LATER studio-wide slot — outside the stale scoped window — is still
    // bookable after the rollback.
    const fett = await seedFettStudio({
      treatingCount: 1,
      open: "09:00",
      close: "17:00",
    });
    try {
      const p1 = fett.treating[0].practitionerId;
      const dow = (
        await adminQuery(
          `select extract(dow from (${FETT_DEMO_SLOT_SQL} at time zone 'America/Los_Angeles')::date)::int d`,
        )
      ).rows[0].d;
      // capacity is LIVE by fixture default, so the scoped row is insertable
      await adminQuery(
        `insert into public.studio_availability_default
           (id, studio_id, practitioner_id, day_of_week, is_open, open_time, close_time)
         values (gen_random_uuid(), $1, $2, $3, true, '10:00', '12:00')`,
        [fett.studioId, p1, dow],
      );
      await setFettCapacityState(fett.studioId, "legacy");

      // 14:00 local is inside the studio-wide 09:00-17:00 window and OUTSIDE
      // the retained scoped 10:00-12:00 one.
      const late = await adminQuery(
        `select * from public.create_public_appointment_v2(
           $1, $2, $3, ${FETT_DEMO_SLOT_SQL} + interval '4 hours', $4, null, null, $5)`,
        [fett.studioId, fett.clientId, fett.services.treatmentId, tok(), p1],
      );
      expect(
        late.rows[0].result,
        "the stale scoped window must not govern a capacity-OFF studio",
      ).toBe("created");
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("an OFF-GRID instant is still refused — the membership gate still bites", async () => {
    // The scoped membership gate must accept only what the scoped page offers.
    // Pointing it at a practitioner-scoped candidate set must not make it
    // permissive about arbitrary times.
    const fett = await seedFettStudio({ treatingCount: 1 });
    try {
      const offGrid = await adminQuery(
        `select * from public.create_public_appointment_v2(
           $1, $2, $3, ${FETT_DEMO_SLOT_SQL} + interval '17 minutes', $4, null, null, $5)`,
        [
          fett.studioId,
          fett.clientId,
          fett.services.treatmentId,
          tok(),
          fett.treating[0].practitionerId,
        ],
      );
      expect(offGrid.rows[0].result).not.toBe("created");
      expect(offGrid.rows[0].appointment_id).toBeNull();
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("STUDIO ISOLATION: a booking in one studio frees nothing and blocks nothing in another", async () => {
    const a = await seedFettStudio({ treatingCount: 1 });
    const b = await seedFettStudio({ treatingCount: 1 });
    try {
      const inA = await bookPublicV2(a, a.treating[0].practitionerId);
      expect(inA.result).toBe("created");
      // Studio B's practitioner takes the same instant, unaffected.
      const inB = await bookPublicV2(b, b.treating[0].practitionerId);
      expect(inB.result).toBe("created");
      expect(inB.starts_at!.getTime()).toBe(inA.starts_at!.getTime());
      for (const [s, label] of [[a, "A"], [b, "B"]] as const) {
        expect(
          Number(
            (
              await adminQuery(
                `select count(*) n from public.appointments where studio_id = $1`,
                [s.studioId],
              )
            ).rows[0].n,
          ),
          `studio ${label} must hold exactly its own booking`,
        ).toBe(1);
      }
    } finally {
      await dropFettStudio(a);
      await dropFettStudio(b);
    }
  });
});

describe("0222 — the audit row survives the move to the shared helper", () => {
  it("writes exactly one 'created' audit row, identical in shape to v1's", async () => {
    // v2 routes its audit through write_appointment_audit instead of inlining
    // the INSERT, so it does not become a ninth appointment_audit writer (that
    // set is pinned by tests/db/appointment-audit-invariant.db.test.ts). The
    // row must be unchanged by that move: same actor_type, actor_id, action and
    // details, with studio_id trigger-derived.
    const viaV2 = await seedFettStudio({ treatingCount: 1 });
    const viaV1 = await seedFettStudio({ treatingCount: 1 });
    try {
      const b2 = await bookPublicV2(viaV2, viaV2.treating[0].practitionerId);
      expect(b2.result).toBe("created");
      const b1 = await bookPublicV1(viaV1);
      expect(b1.result).toBe("created");

      const rows = async (studioId: string) =>
        (
          await adminQuery(
            `select a.actor_type, a.actor_id, a.action, a.details, a.studio_id
               from public.appointment_audit a
              where a.studio_id = $1
              order by a.created_at`,
            [studioId],
          )
        ).rows;

      const r2 = await rows(viaV2.studioId);
      const r1 = await rows(viaV1.studioId);
      expect(r2).toHaveLength(1);
      expect(r1).toHaveLength(1);

      expect(r2[0].actor_type).toBe("client");
      expect(r2[0].actor_id).toBeNull();
      expect(r2[0].action).toBe("created");
      expect(r2[0].details.source).toBe("public_booking");
      expect(r2[0].studio_id).toBe(viaV2.studioId);

      // Field-for-field equal to what v1 writes, except the studio it belongs to.
      expect(r2[0].actor_type).toBe(r1[0].actor_type);
      expect(r2[0].actor_id).toBe(r1[0].actor_id);
      expect(r2[0].action).toBe(r1[0].action);
      expect(r2[0].details).toEqual(r1[0].details);
    } finally {
      await dropFettStudio(viaV2);
      await dropFettStudio(viaV1);
    }
  });
});

describe("0222 — the existing public booking flow is untouched", () => {
  it("v1 still books, and v1 still refuses a studio-wide conflict", async () => {
    // 0170's command and validator are left in place. This proves 0222 did not
    // change the path every current caller uses.
    const fett = await seedFettStudio({ treatingCount: 2 });
    try {
      const first = await bookPublicV1(fett);
      expect(first.result).toBe("created");
      // v1 assigns the single active owner and is studio-wide, so a second v1
      // booking at the same instant must be refused.
      const second = await bookPublicV1(fett);
      expect(second.result).not.toBe("created");
      expect(first.practitioner_id).toBe(fett.practitionerId);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("a v1 booking and a v2 scoped booking see each other correctly under LIVE", async () => {
    // v1 attributes to the owner; a DIFFERENT practitioner chosen through v2
    // must still be able to take the same instant, and the SAME one must not.
    const fett = await seedFettStudio({ treatingCount: 2 });
    try {
      const viaV1 = await bookPublicV1(fett);
      expect(viaV1.result).toBe("created");
      expect(viaV1.practitioner_id).toBe(fett.practitionerId);

      const c2 = await seedClient(fett.studioId, "SYNTH-FETT client 2");
      const other = await bookPublicV2(fett, fett.treating[0].practitionerId, c2);
      expect(other.result).toBe("created");

      const c3 = await seedClient(fett.studioId, "SYNTH-FETT client 3");
      const sameAsOwner = await bookPublicV2(fett, fett.practitionerId, c3);
      expect(sameAsOwner.result).not.toBe("created");
    } finally {
      await dropFettStudio(fett);
    }
  });
});
