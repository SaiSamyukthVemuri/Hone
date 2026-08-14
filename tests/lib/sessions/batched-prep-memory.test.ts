import { afterEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// Dashboard V2 Part 2A, the BATCHED previous-treatment loader.
// ===========================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// The dashboard renders every appointment of the day at once. Reading the
// previous treatment per appointment would be an N+1 that grows with the
// studio's schedule, so the loading is batched. Batching is where three
// specific things go wrong, and each is invisible in a screenshot:
//
//   1. CROSS-CLIENT BLEED. One `.in(...)` read returns every client's rows in
//      one array. Route them wrongly and a practitioner prepares for the wrong
//      person's treatment, the worst failure this feature can have.
//   2. SHARED BOUNDS. Each appointment has its OWN `before` (its starts_at) and
//      its own exclusion. A batch that applies one client's bound to another
//      silently shows a treatment that has not happened yet.
//   3. SILENT TRUNCATION. One read shares a row budget. A client crowded out of
//      the window has NOT been shown to have no history, and rendering that as
//      "new client" is exactly the failure the charted-session authority exists
//      to prevent.
//
// These are behavioural tests against the real exported function with a faked
// PostgREST client, not source greps: a source grep cannot tell whether rows
// were routed to the right client.

const STUDIO = "11111111-1111-1111-1111-111111111111";
const ALICE = "aaaaaaaa-0000-0000-0000-00000000000a";
const BOB = "bbbbbbbb-0000-0000-0000-00000000000b";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { loadLastChartedTreatmentsForClients } from "@/lib/sessions/last-treatment-loader";

afterEach(() => vi.clearAllMocks());

type Row = Record<string, unknown>;

/** Every query the loader issued, for the N+1 assertions. */
type Issued = { table: string; filters: string[] };

/**
 * A chainable PostgREST fake. Records the table and the filter verbs used, and
 * resolves to whatever rows the test supplies for that table.
 */
function fakeSupabase(tables: Record<string, Row[]>, issued: Issued[]) {
  return {
    from(table: string) {
      const record: Issued = { table, filters: [] };
      issued.push(record);
      const builder: Record<string, unknown> = {};
      for (const verb of ["select", "eq", "in", "is", "lt", "order", "limit"]) {
        builder[verb] = (...args: unknown[]) => {
          record.filters.push(`${verb}:${String(args[0] ?? "")}`);
          return builder;
        };
      }
      // `limit` and `order` terminate the chain in this loader; both are
      // awaited, so the builder itself is thenable.
      (builder as { then: unknown }).then = (
        resolve: (v: { data: Row[]; error: null }) => unknown,
      ) => resolve({ data: tables[table] ?? [], error: null });
      return builder;
    },
  };
}

/** A charted session row: one live entry + a block makes it "charted". */
function session(over: Partial<Row> & { id: string; client_id: string }): Row {
  return {
    started_at: "2026-01-10T10:00:00Z",
    modality: "electrolysis",
    record_status: "active",
    deleted_at: null,
    appointment_id: null,
    session_notes: null,
    next_session_note: null,
    electrolysis_entries: [
      { id: `${over.id}-e1`, block_id: `${over.id}-b1`, deleted_at: null, created_at: "2026-01-10T10:05:00Z" },
    ],
    laser_entries: [],
    ...over,
  };
}

function block(sessionId: string): Row {
  return {
    id: `${sessionId}-b1`,
    session_id: sessionId,
    sort_order: 0,
    primary_area: "Chin",
    side: null,
    structured_areas: [],
    deleted_at: null,
  };
}

async function run(
  tables: Record<string, Row[]>,
  requests: Array<{
    requestKey?: string;
    clientId: string;
    before?: string | null;
    excludeAppointmentId?: string | null;
  }>,
  opts?: { limitPerClient?: number },
) {
  const issued: Issued[] = [];
  vi.mocked(createClient).mockResolvedValue(
    fakeSupabase(tables, issued) as unknown as Awaited<ReturnType<typeof createClient>>,
  );
  const out = await loadLastChartedTreatmentsForClients({
    studioId: STUDIO,
    // Cases that are ABOUT one appointment per client key by clientId for
    // readability; the same-client cases pass an explicit appointment key.
    requests: requests.map((r) => ({ requestKey: r.requestKey ?? r.clientId, ...r })),
    ...opts,
  });
  return { out, issued };
}

// ---------------------------------------------------------------------------

describe("batched prep memory: one client cannot receive another's treatment", () => {
  it("routes each client's session to that client and no other", async () => {
    const { out } = await run(
      {
        sessions: [
          session({ id: "s-bob", client_id: BOB, started_at: "2026-02-01T10:00:00Z" }),
          session({ id: "s-alice", client_id: ALICE, started_at: "2026-01-01T10:00:00Z" }),
        ],
        session_blocks: [block("s-bob"), block("s-alice")],
      },
      [{ clientId: ALICE }, { clientId: BOB }],
    );

    expect(out.get(ALICE)?.treatment?.session.id).toBe("s-alice");
    expect(out.get(BOB)?.treatment?.session.id).toBe("s-bob");
    // The decisive assertion: Bob's NEWER session must not leak to Alice just
    // because it came first in the shared result array.
    expect(out.get(ALICE)?.treatment?.session.id).not.toBe("s-bob");
  });

  it("a client with no rows of their own gets nothing, not the other client's", async () => {
    const { out } = await run(
      {
        sessions: [session({ id: "s-bob", client_id: BOB })],
        session_blocks: [block("s-bob")],
      },
      [{ clientId: ALICE }, { clientId: BOB }],
    );
    expect(out.get(ALICE)?.treatment).toBeNull();
    expect(out.get(ALICE)?.unavailable).toBe(false); // genuinely none, window intact
    expect(out.get(BOB)?.treatment?.session.id).toBe("s-bob");
  });

  it("narrative never crosses clients either", async () => {
    const { out } = await run(
      {
        sessions: [
          session({
            id: "s-bob",
            client_id: BOB,
            next_session_note: "BOB PLAN",
            session_notes: "BOB NOTES",
          }),
          session({ id: "s-alice", client_id: ALICE }),
        ],
        session_blocks: [block("s-bob"), block("s-alice")],
      },
      [{ clientId: ALICE }, { clientId: BOB }],
    );
    expect(out.get(BOB)?.narrative.plan?.text).toBe("BOB PLAN");
    expect(out.get(ALICE)?.narrative.plan).toBeNull();
    expect(out.get(ALICE)?.narrative.legacySessionNotes).toBeNull();
  });
});

describe("batched prep memory: each appointment keeps its OWN boundary", () => {
  it("a per-client `before` excludes a session that starts after that appointment", async () => {
    const rows = {
      sessions: [
        session({ id: "s-late", client_id: ALICE, started_at: "2026-03-01T10:00:00Z" }),
        session({ id: "s-early", client_id: ALICE, started_at: "2026-01-01T10:00:00Z" }),
      ],
      session_blocks: [block("s-late"), block("s-early")],
    };
    // An appointment BEFORE the late session must not see it, even though the
    // shared SQL bound (the loosest) let the row into the batch.
    const { out } = await run(rows, [
      { clientId: ALICE, before: "2026-02-01T00:00:00Z" },
    ]);
    expect(out.get(ALICE)?.treatment?.session.id).toBe("s-early");
  });

  it("TWO appointments for the SAME client, in ONE batch, resolve independently", async () => {
    // THE REGRESSION THIS FILE EXISTS FOR.
    //
    // An earlier version keyed both the candidate map and the result map by
    // clientId, so two requests for the same client overwrote each other and
    // both appointments received whichever was written last. The dashboard then
    // read `prepLoads.get(appt.client_id)`, so a client with a morning and an
    // afternoon appointment saw ONE answer on both rows, the afternoon
    // appointment's previous treatment shown against the morning one.
    //
    // The previous test for this ran the two requests in SEPARATE loader
    // invocations, which is precisely the case that cannot collide. It passed
    // throughout. One invocation, two requests, is the only shape that proves
    // it.
    const rows = {
      sessions: [
        session({ id: "s-mid", client_id: ALICE, started_at: "2026-02-15T10:00:00Z" }),
        session({ id: "s-early", client_id: ALICE, started_at: "2026-01-01T10:00:00Z" }),
      ],
      session_blocks: [block("s-mid"), block("s-early")],
    };
    const { out } = await run(rows, [
      { requestKey: "appt-early", clientId: ALICE, before: "2026-02-01T00:00:00Z" },
      { requestKey: "appt-late", clientId: ALICE, before: "2026-03-01T00:00:00Z" },
    ]);

    // Asserted SIMULTANEOUSLY from one batch, the whole point.
    expect(out.get("appt-early")?.treatment?.session.id).toBe("s-early");
    expect(out.get("appt-late")?.treatment?.session.id).toBe("s-mid");
    // ...and they are genuinely different answers, not one value read twice.
    expect(out.get("appt-early")?.treatment?.session.id).not.toBe(
      out.get("appt-late")?.treatment?.session.id,
    );
    expect(out.size).toBe(2);
  });

  it("TWO same-client requests with different exclusions cannot affect each other", async () => {
    // The same collision through the other per-request field. Each appointment
    // must exclude ITS OWN linked session and no one else's.
    const rows = {
      sessions: [
        session({ id: "s-a", client_id: ALICE, started_at: "2026-02-15T10:00:00Z", appointment_id: "appt-a" }),
        session({ id: "s-b", client_id: ALICE, started_at: "2026-01-01T10:00:00Z", appointment_id: "appt-b" }),
      ],
      session_blocks: [block("s-a"), block("s-b")],
    };
    const { out } = await run(rows, [
      // Excluding its own session s-a leaves s-b as the prior treatment.
      { requestKey: "appt-a", clientId: ALICE, excludeAppointmentId: "appt-a" },
      // Excluding its own session s-b leaves the NEWER s-a.
      { requestKey: "appt-b", clientId: ALICE, excludeAppointmentId: "appt-b" },
    ]);
    expect(out.get("appt-a")?.treatment?.session.id).toBe("s-b");
    expect(out.get("appt-b")?.treatment?.session.id).toBe("s-a");
    expect(out.size).toBe(2);
  });

  it("a same-client batch still issues only the two waves", async () => {
    const rows = {
      sessions: [
        session({ id: "s-mid", client_id: ALICE, started_at: "2026-02-15T10:00:00Z" }),
        session({ id: "s-early", client_id: ALICE, started_at: "2026-01-01T10:00:00Z" }),
      ],
      session_blocks: [block("s-mid"), block("s-early")],
    };
    const { issued } = await run(rows, [
      { requestKey: "appt-early", clientId: ALICE, before: "2026-02-01T00:00:00Z" },
      { requestKey: "appt-late", clientId: ALICE, before: "2026-03-01T00:00:00Z" },
    ]);
    // Per-request evaluation must NOT have become a per-request query.
    expect(issued.map((q) => q.table)).toEqual(["sessions", "session_blocks"]);
    // The client is read ONCE even though two requests name it.
    expect(issued[0].filters.filter((f) => f === "in:client_id")).toHaveLength(1);
  });

  it("this appointment's OWN linked session is never its own previous treatment", async () => {
    const { out } = await run(
      {
        sessions: [
          session({ id: "s-today", client_id: ALICE, appointment_id: "appt-1" }),
          session({ id: "s-prior", client_id: ALICE, started_at: "2026-01-01T10:00:00Z" }),
        ],
        session_blocks: [block("s-today"), block("s-prior")],
      },
      [{ clientId: ALICE, excludeAppointmentId: "appt-1" }],
    );
    expect(out.get(ALICE)?.treatment?.session.id).toBe("s-prior");
  });
});

describe("batched prep memory: truncation is reported, never guessed", () => {
  it("a client crowded out of a full window reads UNAVAILABLE, not 'no history'", async () => {
    // limitPerClient 1 with two clients ⇒ budget 2, and both rows belong to Bob.
    // Alice was not proven to have nothing; the window simply never reached her.
    const { out } = await run(
      {
        sessions: [
          session({ id: "s-b1", client_id: BOB, started_at: "2026-03-01T10:00:00Z" }),
          session({ id: "s-b2", client_id: BOB, started_at: "2026-02-01T10:00:00Z" }),
        ],
        session_blocks: [block("s-b1"), block("s-b2")],
      },
      [{ clientId: ALICE }, { clientId: BOB }],
      { limitPerClient: 1 },
    );
    expect(out.get(ALICE)?.treatment).toBeNull();
    expect(
      out.get(ALICE)?.unavailable,
      "a truncated window must not be reported as 'this client has no treatment'",
    ).toBe(true);
  });

  it("an UNtruncated window reports a genuinely empty history as such", () => {
    // The two-way self-test: without it, 'always unavailable' would satisfy the
    // case above and the distinction would be worthless.
    return run(
      { sessions: [session({ id: "s-bob", client_id: BOB })], session_blocks: [block("s-bob")] },
      [{ clientId: ALICE }, { clientId: BOB }],
      { limitPerClient: 25 },
    ).then(({ out }) => {
      expect(out.get(ALICE)?.treatment).toBeNull();
      expect(out.get(ALICE)?.unavailable).toBe(false);
    });
  });
});

describe("batched prep memory: no per-appointment query loop", () => {
  it("issues a CONSTANT number of reads regardless of appointment count", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `client-${i}`);
    const { issued } = await run(
      {
        sessions: many.map((c, i) =>
          session({ id: `s-${i}`, client_id: c, started_at: `2026-01-${String(i + 1).padStart(2, "0")}T10:00:00Z` }),
        ),
        session_blocks: many.map((_, i) => block(`s-${i}`)),
      },
      many.map((c) => ({ clientId: c })),
    );
    // TWO waves for twelve clients: candidates, then blocks. Not 24.
    expect(issued.map((q) => q.table)).toEqual(["sessions", "session_blocks"]);
  });

  it("both reads are keyed by an IN list, which is what makes them batches", async () => {
    const { issued } = await run(
      {
        sessions: [session({ id: "s-a", client_id: ALICE }), session({ id: "s-b", client_id: BOB })],
        session_blocks: [block("s-a"), block("s-b")],
      },
      [{ clientId: ALICE }, { clientId: BOB }],
    );
    expect(issued[0].filters).toContain("in:client_id");
    expect(issued[1].filters).toContain("in:session_id");
    // Studio scoping is explicit on both, defence-in-depth behind RLS.
    expect(issued[0].filters).toContain("eq:studio_id");
    expect(issued[1].filters).toContain("eq:studio_id");
  });

  it("no candidate read is issued at all when there are no requests", async () => {
    const { out, issued } = await run({}, []);
    expect(out.size).toBe(0);
    expect(issued).toHaveLength(0);
  });

  it("skips the block read entirely when no client has a candidate", async () => {
    const { issued } = await run({ sessions: [], session_blocks: [] }, [{ clientId: ALICE }]);
    expect(issued.map((q) => q.table)).toEqual(["sessions"]);
  });
});
