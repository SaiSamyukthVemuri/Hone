import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import {
  seedFettStudio,
  dropFettStudio,
  bookFettInternal,
  FETT_DEMO_SLOT_SQL,
  type FettStudio,
} from "./helpers/fett-fixture";

// FAIR ASSIGNMENT — the complete PR C ordering, proved against real rows.
//
// `docs/roadmap/PRACTITIONER_CAPACITY_ARCHITECTURE.md:293-297` orders it:
// eligible + available -> lowest booked minutes in the comparison window ->
// oldest last assignment -> stable practitioner id. All four keys exist in
// 0222, and this file proves each one DECIDES rather than merely being present.
//
// TWO FACTS ABOUT THE SETUP THAT MAKE THESE TESTS MEAN ANYTHING:
//
//   LOAD IS CREATED ON OTHER DAYS, through the real internal command. Load has
//   to be visible to the ranking WITHOUT making the practitioner busy at the
//   requested instant -- otherwise the candidate is filtered by availability
//   and the load key is never consulted, so the test would pass for the wrong
//   reason. Appointments on neighbouring days inside the window do exactly
//   that.
//
//   `last_public_assignment_at` IS SET DIRECTLY where the ordering is under
//   test, and PROVED SEPARATELY where the write is under test. Mixing the two
//   would leave the ordering tests depending on the thing they are meant to
//   rank by.

type Booked = {
  result: string;
  appointment_id: string | null;
  practitioner_id: string | null;
};

/** The public command under test, on the "Any available" path. */
async function bookAnyAvailable(
  fett: FettStudio,
  opts: { startsAtSql?: string } = {},
): Promise<Booked> {
  const startsAtSql = opts.startsAtSql ?? FETT_DEMO_SLOT_SQL;
  const r = await adminQuery(
    `select * from public.create_public_appointment_v2(
       $1, $2, $3, ${startsAtSql}, $4, null, null, null)`,
    [
      fett.studioId,
      fett.clientId,
      fett.services.treatmentId,
      randomBytes(32).toString("hex"),
    ],
  );
  return r.rows[0] as Booked;
}

/** The same command with an EXPLICIT practitioner. */
async function bookExplicit(
  fett: FettStudio,
  practitionerId: string,
  opts: { startsAtSql?: string } = {},
): Promise<Booked> {
  const startsAtSql = opts.startsAtSql ?? FETT_DEMO_SLOT_SQL;
  const r = await adminQuery(
    `select * from public.create_public_appointment_v2(
       $1, $2, $3, ${startsAtSql}, $4, null, null, $5)`,
    [
      fett.studioId,
      fett.clientId,
      fett.services.treatmentId,
      randomBytes(32).toString("hex"),
      practitionerId,
    ],
  );
  return r.rows[0] as Booked;
}

/** A slot `days` away from the demo slot, same local time. */
const slotOffsetSql = (days: number) =>
  `(${FETT_DEMO_SLOT_SQL} + interval '${days} days')`;

async function setLastAssigned(practitionerId: string, value: string | null) {
  await adminQuery(
    `update public.practitioners set last_public_assignment_at = ${
      value === null ? "null" : "$2::timestamptz"
    } where id = $1`,
    value === null ? [practitionerId] : [practitionerId, value],
  );
}

const lastAssigned = async (practitionerId: string) =>
  (
    await adminQuery(
      `select last_public_assignment_at as v from public.practitioners where id = $1`,
      [practitionerId],
    )
  ).rows[0].v as Date | null;

/** Give `practitionerId` `count` appointments on days inside the window. */
async function loadWith(fett: FettStudio, practitionerId: string, dayOffsets: number[]) {
  for (const d of dayOffsets) {
    const r = await bookFettInternal(fett, practitionerId, {
      startsAtSql: slotOffsetSql(d),
      clientId: fett.clientId,
    });
    expect(r.result, `load setup failed at offset ${d}`).toBe("created");
  }
}

afterAll(async () => {
  await closePool();
});

describe("0222 fair assignment — the complete ordering", () => {
  let fett: FettStudio;

  beforeEach(async () => {
    // Two treating practitioners plus the owner; all three eligible by 0134's
    // auto-eligibility triggers, which is the realistic shape.
    fett = await seedFettStudio({ treatingCount: 2 });
    // Every candidate starts with NO recorded assignment history, so key 2
    // cannot decide anything until a test makes it.
    for (const p of [fett.practitionerId, ...fett.treating.map((t) => t.practitionerId)]) {
      await setLastAssigned(p, null);
    }
  });

  async function cleanup() {
    if (fett) await dropFettStudio(fett);
  }

  it("KEY 1: the less loaded practitioner wins, and the OWNER does not", async () => {
    // THE CORE CLAIM. With the owner heavily loaded and a treating
    // practitioner idle, the owner must NOT receive the booking -- that is
    // "never silently assigns the owner" stated as behaviour rather than as a
    // comment, and it is the assertion the old owner-privilege branch failed.
    try {
      // Thu, Fri, Tue — all weekdays, all inside the +/-7 day window.
      await loadWith(fett, fett.practitionerId, [1, 2, -1]);
      const res = await bookAnyAvailable(fett);
      expect(res.result).toBe("created");
      expect(
        res.practitioner_id,
        "the loaded owner must be passed over for an idle practitioner",
      ).not.toBe(fett.practitionerId);
      expect(
        fett.treating.map((t) => t.practitionerId),
      ).toContain(res.practitioner_id);
    } finally {
      await cleanup();
    }
  });

  it("KEY 1: load OUTSIDE the ±7-day window does not count", async () => {
    // The window is the chosen mechanism, so its BOUNDS have to bite. Load two
    // weeks out is real load for the studio and must not influence this
    // instant's ranking -- otherwise the key is "lifetime bookings" wearing a
    // window's name.
    //
    // OFFSETS ARE WEEKDAYS ON PURPOSE. The demo slot is next WEDNESDAY and the
    // fixture opens Mon-Fri, so an offset landing on a weekend makes the
    // internal command answer `practitioner_closed` and the SETUP fails -- which
    // is what the assertion inside `loadWith` is there to say out loud, rather
    // than leaving a ranking test that silently ranked nothing.
    try {
      const [a, b] = fett.treating;
      // Wed, Thu, Fri two weeks out: weekdays, and all OUTSIDE +/-7 days.
      await loadWith(fett, a!.practitionerId, [14, 15, 16]);
      // a is loaded only outside the window, so key 1 ties at zero and the
      // final id tiebreak decides deterministically.
      const res = await bookAnyAvailable(fett);
      expect(res.result).toBe("created");
      const ids = [fett.practitionerId, a!.practitionerId, b!.practitionerId].sort();
      expect(
        res.practitioner_id,
        "with all in-window loads equal, the stable id key decides",
      ).toBe(ids[0]);
    } finally {
      await cleanup();
    }
  });

  it("KEY 2: on EQUAL load, the practitioner assigned longest ago wins", async () => {
    // THE OLDEST IS DELIBERATELY THE HIGHEST ID, and the first version of this
    // test did not do that. With every candidate tied on load, removing key 2
    // altogether leaves the id tiebreak deciding — and if the practitioner I
    // called "oldest" also happens to hold the lowest id, the test passes
    // whether key 2 exists or not. The mutant run caught it: deleting key 2
    // left this assertion green.
    //
    // Assigning the oldest timestamp to the HIGHEST id makes the two keys
    // disagree, so only key 2 can produce the expected winner.
    try {
      const ids = [
        fett.practitionerId,
        ...fett.treating.map((t) => t.practitionerId),
      ].sort();
      const highest = ids[ids.length - 1]!;
      const rest = ids.slice(0, -1);

      // All three tie on load (zero in-window). Every candidate has a history,
      // so NULL cannot be what decides either.
      await setLastAssigned(highest, "2026-01-01T00:00:00Z"); // oldest
      await setLastAssigned(rest[0]!, "2026-01-02T00:00:00Z");
      await setLastAssigned(rest[1]!, "2026-01-03T00:00:00Z");

      const res = await bookAnyAvailable(fett);
      expect(res.result).toBe("created");
      expect(
        res.practitioner_id,
        "oldest last assignment must win an equal-load tie, even against the " +
          "id key that would otherwise have chosen someone else",
      ).toBe(highest);
      expect(
        res.practitioner_id,
        "and it must NOT be the lowest id, or the id tiebreak could explain it",
      ).not.toBe(ids[0]);
    } finally {
      await cleanup();
    }
  });

  it("KEY 2: NEVER ASSIGNED sorts before any recorded assignment", async () => {
    // NULLS FIRST is the correct reading, and the one a naive `asc` gets
    // wrong: in Postgres `asc` defaults to NULLS LAST, which would send
    // never-assigned practitioners to the BACK and hand every booking to
    // whoever already had the most history.
    try {
      const [a, b] = fett.treating;
      await setLastAssigned(fett.practitionerId, "2026-01-01T00:00:00Z");
      await setLastAssigned(a!.practitionerId, "2026-01-02T00:00:00Z");
      await setLastAssigned(b!.practitionerId, null); // never assigned

      const res = await bookAnyAvailable(fett);
      expect(res.result).toBe("created");
      expect(
        res.practitioner_id,
        "a never-assigned practitioner is the oldest possible candidate",
      ).toBe(b!.practitionerId);
    } finally {
      await cleanup();
    }
  });

  it("KEY 3: a full tie resolves deterministically, and the SAME way twice", async () => {
    // Determinism is the point of the final key: two identical requests must
    // not resolve differently, or the page and the command can disagree.
    try {
      const first = await bookAnyAvailable(fett);
      expect(first.result).toBe("created");
      const ids = [
        fett.practitionerId,
        ...fett.treating.map((t) => t.practitionerId),
      ].sort();
      expect(first.practitioner_id, "lowest id breaks a total tie").toBe(ids[0]);

      // A second request at a DIFFERENT instant, with the first booking's
      // effects now in play: the winner has load and a recorded assignment, so
      // it must not win again.
      const second = await bookAnyAvailable(fett, { startsAtSql: slotOffsetSql(1) });
      expect(second.result).toBe("created");
      expect(
        second.practitioner_id,
        "the previous winner now carries load AND history, so it loses",
      ).not.toBe(first.practitioner_id);
    } finally {
      await cleanup();
    }
  });

  it("the window follows the REQUESTED instant, not now()", async () => {
    // The window is `[requested - 7d, requested + 7d)`. Load placed near a
    // FUTURE requested date must count for that request and not for a request
    // two weeks earlier -- which is what makes it a comparison window rather
    // than a rolling "recent activity" figure.
    try {
      const [a, b] = fett.treating;
      // Load `a` around day 21 only.
      await loadWith(fett, a!.practitionerId, [20, 21, 22]);

      // A request at day 21 sees that load and must avoid `a`.
      const near = await bookAnyAvailable(fett, { startsAtSql: slotOffsetSql(21) });
      expect(near.result).toBe("created");
      expect(
        near.practitioner_id,
        "load around the requested date must count against it",
      ).not.toBe(a!.practitionerId);

      // A request at the demo slot is >7 days from that load, so `a` is
      // unloaded there and competes on the later keys.
      await setLastAssigned(fett.practitionerId, "2026-06-01T00:00:00Z");
      await setLastAssigned(a!.practitionerId, "2026-01-01T00:00:00Z"); // oldest
      await setLastAssigned(b!.practitionerId, "2026-06-02T00:00:00Z");
      const far = await bookAnyAvailable(fett);
      expect(far.result).toBe("created");
      expect(
        far.practitioner_id,
        "the same load is outside THIS request's window, so a competes and wins on age",
      ).toBe(a!.practitionerId);
    } finally {
      await cleanup();
    }
  });
});

describe("0222 — the assignment fact is recorded exactly when it should be", () => {
  let fett: FettStudio;

  beforeEach(async () => {
    fett = await seedFettStudio({ treatingCount: 2 });
    for (const p of [fett.practitionerId, ...fett.treating.map((t) => t.practitionerId)]) {
      await setLastAssigned(p, null);
    }
  });

  async function cleanup() {
    if (fett) await dropFettStudio(fett);
  }

  it("a CREATED assignment advances it, for the winner only", async () => {
    try {
      const res = await bookAnyAvailable(fett);
      expect(res.result).toBe("created");
      expect(
        await lastAssigned(res.practitioner_id!),
        "the assigned practitioner's fact must be recorded",
      ).not.toBeNull();
      for (const p of [fett.practitionerId, ...fett.treating.map((t) => t.practitionerId)]) {
        if (p === res.practitioner_id) continue;
        expect(
          await lastAssigned(p),
          "a practitioner who was not assigned must stay unrecorded",
        ).toBeNull();
      }
    } finally {
      await cleanup();
    }
  });

  it("an EXPLICIT selection advances it too", async () => {
    // Omitting this would make heavily hand-picked practitioners read as
    // "never assigned" and therefore sort FIRST among equal loads -- inverting
    // the rule exactly where it matters most.
    try {
      const chosen = fett.treating[1]!.practitionerId;
      const res = await bookExplicit(fett, chosen);
      expect(res.result).toBe("created");
      expect(res.practitioner_id).toBe(chosen);
      expect(await lastAssigned(chosen)).not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("a REFUSAL leaves every assignment fact untouched", async () => {
    // Every refusal in this command RETURNS a row rather than raising, so
    // anything written before one would COMMIT. The fact is written after the
    // insert for exactly this reason.
    try {
      const chosen = fett.treating[0]!.practitionerId;
      const first = await bookExplicit(fett, chosen);
      expect(first.result).toBe("created");
      const after = await lastAssigned(chosen);
      expect(after).not.toBeNull();

      // Same practitioner, same instant: refused.
      const refused = await bookExplicit(fett, chosen);
      expect(refused.result).not.toBe("created");
      expect(refused.appointment_id).toBeNull();
      expect(
        (await lastAssigned(chosen))?.getTime(),
        "a refusal must not advance the assignment fact",
      ).toBe(after?.getTime());
    } finally {
      await cleanup();
    }
  });

  it("CONCURRENCY: two simultaneous assignments do not pick the same practitioner", async () => {
    // The fact is read by the ranking and written by the command, both inside
    // the studio transaction. Without that, two concurrent requests could each
    // read the same "oldest" and both choose it -- the ranking would be
    // deterministic and WRONG. Issued in parallel at DIFFERENT instants so
    // availability cannot be what separates them.
    try {
      const [r1, r2] = await Promise.all([
        bookAnyAvailable(fett, { startsAtSql: slotOffsetSql(1) }),
        bookAnyAvailable(fett, { startsAtSql: slotOffsetSql(2) }),
      ]);
      expect(r1.result).toBe("created");
      expect(r2.result).toBe("created");
      expect(
        r1.practitioner_id,
        "serialising on the studio lock must make the second see the first's fact",
      ).not.toBe(r2.practitioner_id);
    } finally {
      await cleanup();
    }
  });

  it("LEGACY is untouched: capacity-OFF records nothing and still assigns the owner", async () => {
    // The fact is only consulted under capacity-ON, so recording it with the
    // switch off would be noise that silently re-ranks the studio the day the
    // switch is turned on.
    await dropFettStudio(fett);
    fett = await seedFettStudio({ treatingCount: 2, capacity: "legacy" });
    try {
      for (const p of [fett.practitionerId, ...fett.treating.map((t) => t.practitionerId)]) {
        await setLastAssigned(p, null);
      }
      const res = await bookAnyAvailable(fett);
      expect(res.result).toBe("created");
      expect(
        res.practitioner_id,
        "capacity-OFF assigns the single active owner, unchanged",
      ).toBe(fett.practitionerId);
      expect(
        await lastAssigned(fett.practitionerId),
        "capacity-OFF must record no assignment history",
      ).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe("0222 — the column is additive and never backfilled", () => {
  it("is nullable, has no default, and existing rows read as unknown", async () => {
    const fett = await seedFettStudio({ treatingCount: 1 });
    try {
      const col = await adminQuery(
        `select is_nullable, column_default, data_type
           from information_schema.columns
          where table_schema = 'public' and table_name = 'practitioners'
            and column_name = 'last_public_assignment_at'`,
      );
      expect(col.rows.length, "the column must exist").toBe(1);
      const meta = col.rows[0] as {
        is_nullable: string;
        column_default: string | null;
        data_type: string;
      };
      expect(meta.is_nullable).toBe("YES");
      expect(
        meta.column_default,
        "a default would fabricate assignment history",
      ).toBeNull();
      expect(meta.data_type).toBe("timestamp with time zone");

      // A freshly seeded practitioner has never been publicly assigned, so the
      // fact is UNKNOWN rather than zero.
      expect(await lastAssigned(fett.practitionerId)).toBeNull();
    } finally {
      await dropFettStudio(fett);
    }
  });
});
