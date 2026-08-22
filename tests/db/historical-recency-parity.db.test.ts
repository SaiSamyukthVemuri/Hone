import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import {
  isStrictlyBeforeCanonical,
  parseCanonicalInstant,
} from "@/lib/sessions/history/recency";

// PARITY BETWEEN POSTGRES AND THE ONE JS COMPARISON THE AUTHORITY KEPT.
//
// The authority never sorts in JavaScript: the database produces the canonical
// order and every later step preserves it. Exactly ONE comparison survives — a
// batched read is fetched once with the loosest cutoff, and each appointment
// then keeps the rows strictly before ITS OWN starts_at.
//
// That comparison must agree with Postgres exactly, and the obvious
// implementation does not: `timestamptz` carries MICROSECONDS while
// `new Date(x).getTime()` truncates to MILLISECONDS, so two instants 200µs apart
// are strictly ordered in the database and exactly EQUAL in JavaScript.
//
// These run against the real database rather than fixtures, because the thing
// under test IS the boundary between the two engines.

afterAll(async () => {
  await closePool();
});

/** Postgres' own answer, so the expectation is never hand-written. */
async function pgSaysBefore(a: string, b: string): Promise<boolean> {
  const { rows } = await adminQuery(
    "select ($1::timestamptz < $2::timestamptz) as lt",
    [a, b],
  );
  return (rows[0] as { lt: boolean }).lt;
}

/** How PostgREST serialises an instant — the exact text JavaScript receives. */
async function serialize(literal: string): Promise<string> {
  const { rows } = await adminQuery(
    "select to_jsonb($1::timestamptz) #>> '{}' as t",
    [literal],
  );
  return (rows[0] as { t: string }).t;
}

describe("the JS cutoff comparison agrees with Postgres", () => {
  const PAIRS: ReadonlyArray<readonly [string, string, string]> = [
    ["sub-millisecond — the divergence itself", "2026-03-12T14:00:00.000123Z", "2026-03-12T14:00:00.000456Z"],
    ["one microsecond apart", "2026-03-12T14:00:00.000001Z", "2026-03-12T14:00:00.000002Z"],
    ["trimmed fraction vs padded", "2026-03-12T14:00:00.05Z", "2026-03-12T14:00:00.5Z"],
    ["whole second vs fraction", "2026-03-12T14:00:00Z", "2026-03-12T14:00:00.000001Z"],
    ["across a second", "2026-03-12T14:00:00.999999Z", "2026-03-12T14:00:01Z"],
    ["across a day", "2026-03-12T23:59:59.999999Z", "2026-03-13T00:00:00Z"],
    ["non-UTC offset, same instant either side", "2026-03-12T15:00:00+01:00", "2026-03-12T14:00:00.000001Z"],
  ];

  for (const [label, a, b] of PAIRS) {
    it(`${label}: JS matches Postgres in BOTH directions`, async () => {
      const [sa, sb] = [await serialize(a), await serialize(b)];
      expect(isStrictlyBeforeCanonical(sa, sb)).toBe(await pgSaysBefore(a, b));
      expect(isStrictlyBeforeCanonical(sb, sa)).toBe(await pgSaysBefore(b, a));
    });
  }

  it("the sub-millisecond pair is one `Date` DISCARDS — the control", async () => {
    // Without this the suite could pass with a Date-based implementation and
    // nobody would learn anything from it.
    const [a, b] = [
      await serialize("2026-03-12T14:00:00.000123Z"),
      await serialize("2026-03-12T14:00:00.000456Z"),
    ];
    expect(new Date(a).getTime()).toBe(new Date(b).getTime());
    expect(await pgSaysBefore(a, b)).toBe(true);
    expect(isStrictlyBeforeCanonical(a, b)).toBe(true);
  });

  it("agrees with Postgres over REAL session rows, both directions", async () => {
    const { rows } = await adminQuery(
      `select to_jsonb(x.started_at) #>> '{}' as a, to_jsonb(y.started_at) #>> '{}' as b
         from (select started_at from public.sessions order by started_at desc limit 40) x
         cross join (select started_at from public.sessions order by started_at asc limit 40) y`,
      [],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows as Array<{ a: string; b: string }>) {
      expect(isStrictlyBeforeCanonical(r.a, r.b), `${r.a} < ${r.b}`).toBe(
        await pgSaysBefore(r.a, r.b),
      );
    }
  });

  it("every real serialisation this database produces is PARSEABLE", async () => {
    // An unparseable instant is refused by the authority, so a serialisation
    // shape it cannot read would silently drop real rows.
    const { rows } = await adminQuery(
      "select to_jsonb(started_at) #>> '{}' as t from public.sessions limit 200",
      [],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows as Array<{ t: string }>) {
      expect(parseCanonicalInstant(r.t), r.t).not.toBeNull();
    }
  });
});

describe("the canonical ORDER is total on real data", () => {
  it("started_at alone is NOT total here — ties exist", async () => {
    // The premise of the whole contract. If this returns zero the tie-break
    // looks unnecessary and someone will delete it.
    const { rows } = await adminQuery(
      `select count(*)::text as n from (
         select started_at from public.sessions
          group by started_at having count(*) > 1) t`,
      [],
    );
    expect(Number((rows[0] as { n: string }).n)).toBeGreaterThan(0);
  });

  it("started_at DESC, id DESC yields the SAME rows under different plans", async () => {
    // A non-total order lets the planner decide which tied row survives a LIMIT.
    const q = "select id::text from public.sessions order by started_at desc, id desc limit 25";
    const a = await adminQuery(q, []);
    await adminQuery("set enable_seqscan = off", []);
    const b = await adminQuery(q, []);
    await adminQuery("set enable_seqscan = on", []);
    expect((b.rows as Array<{ id: string }>).map((r) => r.id)).toEqual(
      (a.rows as Array<{ id: string }>).map((r) => r.id),
    );
  });

  it("a bounded read is a PREFIX of a larger one — the top-N theorem", async () => {
    // This is what makes recency safe by construction: the rows lost to a LIMIT
    // are a suffix of the OLDEST, so the newest region is always intact.
    const q = (n: number) =>
      `select id::text from public.sessions order by started_at desc, id desc limit ${n}`;
    const small = (await adminQuery(q(7), [])).rows as Array<{ id: string }>;
    const large = (await adminQuery(q(21), [])).rows as Array<{ id: string }>;
    expect(large.slice(0, small.length).map((r) => r.id)).toEqual(
      small.map((r) => r.id),
    );
  });
});
