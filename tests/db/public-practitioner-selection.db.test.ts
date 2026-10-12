import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import {
  bookFettInternal,
  dropFettStudio,
  seedFettStudio,
  setFettCapacityState,
} from "./helpers/fett-fixture";

// Proves 0219 (G1 public practitioner selection) instead of asserting it.
//
// The gap, reproduced in #840: `create_public_appointment` takes no
// practitioner and derives assignment from the ACTIVE-OWNER COUNT, so in a
// one-owner-plus-five-practitioners studio every public booking lands on the
// owner. 0219 adds the READ side — the picker's options and practitioner-scoped
// candidates — so a client can be offered a named practitioner's real
// availability. The write side is a separate slice.
//
// The load-bearing pair is LIVE vs LEGACY: under LIVE, one practitioner's
// appointment must NOT remove another's candidates (that is the whole point);
// under LEGACY every reservation is keyed to the studio, so it MUST. Without
// the LEGACY half the LIVE half could pass on a function that ignored conflicts
// altogether.
// db-integration lane, real migrated schema (chain 0211-0219).

afterAll(async () => {
  await closePool();
});

const DAY_SQL = `(date_trunc('week', (now() at time zone 'America/Los_Angeles'))
                  + interval '9 days')::date`;

async function optionsFor(studioId: string) {
  const r = await adminQuery(
    `select practitioner_id, display_name, is_owner
       from public.public_booking_practitioner_options($1)`,
    [studioId],
  );
  return r.rows as { practitioner_id: string; display_name: string; is_owner: boolean }[];
}

async function candidatesFor(studioId: string, practitionerId: string | null) {
  const r = await adminQuery(
    `select c from public.public_booking_slot_candidates_for_practitioner(
              $1, ${DAY_SQL}, 60, $2) c`,
    [studioId, practitionerId],
  );
  return r.rows.map((x: { c: Date }) => x.c.getTime()).sort();
}

async function studioWideCandidates(studioId: string) {
  const r = await adminQuery(
    `select c from public.public_booking_slot_candidates($1, ${DAY_SQL}, 60) c`,
    [studioId],
  );
  return r.rows.map((x: { c: Date }) => x.c.getTime()).sort();
}

describe("0219 — the picker's options", () => {
  it("returns every active treating practitioner, owner first, with no PII", async () => {
    const fett = await seedFettStudio({ treatingCount: 5 });
    try {
      const opts = await optionsFor(fett.studioId);
      expect(opts).toHaveLength(6); // owner + 5
      expect(opts[0].is_owner).toBe(true);
      expect(opts[0].practitioner_id).toBe(fett.practitionerId);
      expect(opts.filter((o) => o.is_owner)).toHaveLength(1);
      // Deterministic beyond the owner: display_name then id.
      const rest = opts.slice(1).map((o) => o.display_name);
      expect([...rest].sort()).toEqual(rest);
      // No email, no PII columns.
      expect(Object.keys(opts[0]).sort()).toEqual([
        "display_name",
        "is_owner",
        "practitioner_id",
      ]);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("excludes an inactive practitioner, and another studio's", async () => {
    const a = await seedFettStudio({ treatingCount: 2 });
    const b = await seedFettStudio({ treatingCount: 1 });
    try {
      await adminQuery(
        `update public.practitioners set active = false where id = $1`,
        [a.treating[0].practitionerId],
      );
      const opts = await optionsFor(a.studioId);
      const ids = opts.map((o) => o.practitioner_id);
      expect(ids).not.toContain(a.treating[0].practitionerId);
      expect(ids).toContain(a.treating[1].practitionerId);
      // Tenant isolation: studio B's people never appear in studio A's options.
      for (const p of b.practitioners) {
        expect(ids).not.toContain(p.practitionerId);
      }
    } finally {
      await dropFettStudio(a);
      await dropFettStudio(b);
    }
  });

  it("cannot return a receptionist — they are not a practitioners row", async () => {
    const fett = await seedFettStudio({ treatingCount: 1 });
    try {
      const opts = await optionsFor(fett.studioId);
      expect(opts).toHaveLength(2);
      if (fett.receptionist) {
        // On a chain carrying 0216 the membership exists and is still absent
        // from the picker — excluded twice over: wrong table, and the role
        // filter. This is the "denied by construction" property.
        expect(opts.map((o) => o.practitioner_id)).not.toContain(
          fett.receptionist.receptionistId,
        );
      }
    } finally {
      await dropFettStudio(fett);
    }
  });
});

describe("0219 — practitioner-scoped candidates", () => {
  it("offers a named practitioner real candidates", async () => {
    const fett = await seedFettStudio({ treatingCount: 2 });
    try {
      const c = await candidatesFor(fett.studioId, fett.treating[0].practitionerId);
      expect(c.length).toBeGreaterThan(0);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("refuses NULL, another studio's practitioner, and an inactive one", async () => {
    const a = await seedFettStudio({ treatingCount: 1 });
    const b = await seedFettStudio({ treatingCount: 1 });
    try {
      expect(await candidatesFor(a.studioId, null)).toEqual([]);
      // Cross-tenant: B's practitioner gets nothing from A's studio.
      expect(
        await candidatesFor(a.studioId, b.treating[0].practitionerId),
      ).toEqual([]);
      await adminQuery(
        `update public.practitioners set active = false where id = $1`,
        [a.treating[0].practitionerId],
      );
      expect(
        await candidatesFor(a.studioId, a.treating[0].practitionerId),
      ).toEqual([]);
    } finally {
      await dropFettStudio(a);
      await dropFettStudio(b);
    }
  });

  it("LIVE: one practitioner's appointment does NOT remove another's slots", async () => {
    // THE POINT OF G1.
    const fett = await seedFettStudio({ treatingCount: 2 });
    try {
      const [p1, p2] = fett.treating;
      const before1 = await candidatesFor(fett.studioId, p1.practitionerId);
      const before2 = await candidatesFor(fett.studioId, p2.practitionerId);
      expect(before1.length).toBeGreaterThan(0);
      expect(before2).toEqual(before1);

      const booked = await bookFettInternal(fett, p1.practitionerId);
      expect(booked.result).toBe("created");

      const after1 = await candidatesFor(fett.studioId, p1.practitionerId);
      const after2 = await candidatesFor(fett.studioId, p2.practitionerId);
      // p1 lost the booked slot...
      expect(after1).not.toEqual(before1);
      expect(after1).not.toContain(booked.starts_at!.getTime());
      // ...and p2 kept every one of theirs. This is what the studio-wide
      // function cannot express.
      expect(after2).toEqual(before2);
      expect(after2).toContain(booked.starts_at!.getTime());
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("LEGACY: the same appointment DOES remove the other practitioner's slot", async () => {
    // THE CONTROL that makes the LIVE case mean something. Under LEGACY every
    // reservation is keyed to the STUDIO (0134/0136), so choosing a
    // practitioner buys no parallelism — 0136's model, not a defect.
    const fett = await seedFettStudio({ treatingCount: 2, capacity: "legacy" });
    try {
      const [p1, p2] = fett.treating;
      const before2 = await candidatesFor(fett.studioId, p2.practitionerId);
      expect(before2.length).toBeGreaterThan(0);

      const booked = await bookFettInternal(fett, p1.practitionerId);
      expect(booked.result).toBe("created");

      const after2 = await candidatesFor(fett.studioId, p2.practitionerId);
      expect(after2).not.toContain(booked.starts_at!.getTime());
      expect(after2.length).toBeLessThan(before2.length);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("a practitioner-scoped availability window beats the studio-wide one", async () => {
    const fett = await seedFettStudio({ treatingCount: 1, open: "09:00", close: "17:00" });
    try {
      const p = fett.treating[0].practitionerId;
      const wide = await candidatesFor(fett.studioId, p);
      expect(wide.length).toBeGreaterThan(0);
      // Give this practitioner a narrower own-row for that weekday.
      const dow = await adminQuery(`select extract(dow from ${DAY_SQL})::int as d`);
      await adminQuery(
        `insert into public.studio_availability_default
           (id, studio_id, practitioner_id, day_of_week, is_open, open_time, close_time)
         values (gen_random_uuid(), $1, $2, $3, true, '10:00', '12:00')`,
        [fett.studioId, p, dow.rows[0].d],
      );
      const narrow = await candidatesFor(fett.studioId, p);
      expect(narrow.length).toBeGreaterThan(0);
      expect(narrow.length).toBeLessThan(wide.length);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("NON-DIVERGENCE: with one practitioner under LEGACY it matches the studio-wide function", async () => {
    // 0219 must not quietly invent different slot arithmetic. In the one
    // configuration where both functions describe the same resource, they must
    // agree exactly.
    const fett = await seedFettStudio({ treatingCount: 0, capacity: "legacy" });
    try {
      const wide = await studioWideCandidates(fett.studioId);
      const scoped = await candidatesFor(fett.studioId, fett.practitionerId);
      expect(scoped).toEqual(wide);
      expect(wide.length).toBeGreaterThan(0);
    } finally {
      await dropFettStudio(fett);
    }
  });
});
