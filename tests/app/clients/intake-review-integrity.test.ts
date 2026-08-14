import { beforeEach, describe, expect, it, vi } from "vitest";

// F-CLIN-004: behavioural proof that markIntakeReviewedAction's conditional
// UPDATE is the single authority for an intake review transition.
//
// These are NOT source greps. The real server action is invoked against an
// in-memory fake that implements PostgREST's filter semantics (.eq / .is /
// .not("col","is",null)) over real rows, applies the patch only to rows that
// match EVERY filter, and returns the affected rows from .select(). So a test
// that says "blocked" is asserting that the row genuinely did not change and
// that zero rows came back, not that some string appears in a file.
//
// Scope reminder: this proves the APPLICATION path. The database boundary for
// F-CLIN-004 is still open (migration 0118 does not guard an incoming
// in_progress -> reviewed transition); see tests/db/intake-review-db-boundary
// notes in docs/production/known-limitations.md L22.

// ---------------------------------------------------------------------------
// Fake PostgREST update builder
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type TableState = {
  rows: Row[];
  // When set, the next update rejects with this PostgREST-shaped error.
  failWith?: { message: string; code?: string } | null;
  // Records each update's resolved filter set for assertions.
  updates: Array<{ patch: Row; matched: number }>;
};

function makeFakeSupabase(state: TableState) {
  function builder(patch: Row) {
    const predicates: Array<(r: Row) => boolean> = [];

    const chain = {
      eq(col: string, val: unknown) {
        predicates.push((r) => r[col] === val);
        return chain;
      },
      is(col: string, val: unknown) {
        // PostgREST .is(col, null) => col IS NULL
        predicates.push((r) => r[col] === val);
        return chain;
      },
      not(col: string, op: string, val: unknown) {
        if (op === "is" && val === null) {
          predicates.push((r) => r[col] !== null && r[col] !== undefined);
          return chain;
        }
        throw new Error(`fake supabase: unsupported .not(${col}, ${op})`);
      },
      // .select() terminates the chain and performs the update, exactly like
      // PostgREST's "UPDATE ... RETURNING". It is deliberately the ONLY way to
      // execute: an action that forgets .select() gets no rows back at all.
      async select(cols: string) {
        if (state.failWith) {
          const err = state.failWith;
          state.failWith = null;
          return { data: null, error: err };
        }
        const matched = state.rows.filter((r) => predicates.every((p) => p(r)));
        // Apply the patch atomically to every matched row (single statement).
        for (const r of matched) Object.assign(r, patch);
        state.updates.push({ patch, matched: matched.length });
        const projection = cols.split(",").map((c) => c.trim());
        return {
          data: matched.map((r) =>
            Object.fromEntries(projection.map((c) => [c, r[c]])),
          ),
          error: null,
        };
      },
      // A chain that is awaited WITHOUT .select() resolves with no data. This
      // models the pre-fix behaviour and makes the "must prove one row"
      // negative control fail loudly rather than silently pass.
      then(resolve: (v: { data: null; error: null }) => void) {
        if (state.failWith) {
          const err = state.failWith;
          state.failWith = null;
          return Promise.resolve({ data: null, error: err }).then(
            resolve as never,
          );
        }
        const matched = state.rows.filter((r) => predicates.every((p) => p(r)));
        for (const r of matched) Object.assign(r, patch);
        state.updates.push({ patch, matched: matched.length });
        return Promise.resolve({ data: null, error: null }).then(
          resolve as never,
        );
      },
    };
    return chain;
  }

  return {
    from(table: string) {
      if (table !== "client_intake_forms") {
        throw new Error(`fake supabase: unexpected table ${table}`);
      }
      return { update: (patch: Row) => builder(patch) };
    },
  };
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const STUDIO = "studio-1";
const OTHER_STUDIO = "studio-2";
const PRACTITIONER = "prac-1";
const CLIENT = "client-1";
const OTHER_CLIENT = "client-2";
const INTAKE = "intake-1";
const OTHER_INTAKE = "intake-2";

const state: TableState = { rows: [], failWith: null, updates: [] };

const { createClientSpy, getCurrentPractitionerWithStudio, revalidatePath } =
  vi.hoisted(() => ({
    createClientSpy: vi.fn(),
    getCurrentPractitionerWithStudio: vi.fn(),
    revalidatePath: vi.fn(),
  }));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientSpy }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("the intake review path must not use the service role");
  }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio,
  getPractitionersForStudio: vi.fn(),
}));

import {
  markIntakeReviewedAction,
  saveIntakeNotesAction,
} from "@/app/(app)/clients/[id]/intake/actions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function submittedRow(over: Partial<Row> = {}): Row {
  return {
    id: INTAKE,
    studio_id: STUDIO,
    client_id: CLIENT,
    status: "submitted",
    submitted_at: "2026-07-01T10:00:00.000Z",
    reviewed_at: null,
    reviewed_by: null,
    practitioner_notes: null,
    deleted_at: null,
    ...over,
  };
}

function fd(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("intake_id", INTAKE);
  f.set("client_id", CLIENT);
  f.set("practitioner_notes", "looks fine");
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

function row(id = INTAKE): Row {
  return state.rows.find((r) => r.id === id)!;
}

beforeEach(() => {
  state.rows = [];
  state.failWith = null;
  state.updates = [];
  revalidatePath.mockClear();
  createClientSpy.mockReset();
  createClientSpy.mockImplementation(async () => makeFakeSupabase(state));
  getCurrentPractitionerWithStudio.mockReset();
  getCurrentPractitionerWithStudio.mockResolvedValue({
    practitioner: { id: PRACTITIONER, active: true },
    studio: { id: STUDIO },
  });
});

// The single generic failure string. Every non-success outcome must be
// indistinguishable, so the practitioner cannot probe existence/ownership.
const GENERIC =
  "This intake can only be reviewed after this client submits it. Refresh and check the current intake status.";

describe("F-CLIN-004 / 1. the happy path still works", () => {
  it("submitted + same client + same studio + submitted_at present → reviewed", async () => {
    state.rows = [submittedRow()];
    const before = Date.now();
    const res = await markIntakeReviewedAction(fd());
    const after = Date.now();

    expect(res).toEqual({ ok: true });
    const r = row();
    expect(r.status).toBe("reviewed");
    // reviewed_by is the AUTHENTICATED practitioner, not anything the browser sent.
    expect(r.reviewed_by).toBe(PRACTITIONER);
    // reviewed_at is server-generated and lands inside the call window.
    expect(typeof r.reviewed_at).toBe("string");
    const at = new Date(r.reviewed_at as string).getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    // Exactly one row was affected by exactly one statement.
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].matched).toBe(1);
  });

  it("revalidates the client's own routes using the RETURNED client_id", async () => {
    state.rows = [submittedRow()];
    await markIntakeReviewedAction(fd());
    expect(revalidatePath).toHaveBeenCalledWith(`/clients/${CLIENT}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/clients/${CLIENT}/intake`);
  });
});

describe("F-CLIN-004 / 2. in-progress is blocked", () => {
  it("an in_progress intake cannot be marked reviewed and keeps every field", async () => {
    state.rows = [
      submittedRow({ status: "in_progress", submitted_at: null }),
    ];
    const res = await markIntakeReviewedAction(fd());

    expect(res).toEqual({ ok: false, error: GENERIC });
    const r = row();
    expect(r.status).toBe("in_progress");
    expect(r.submitted_at).toBeNull();
    expect(r.reviewed_at).toBeNull();
    expect(r.reviewed_by).toBeNull();
    // The notes were not written either, a blocked review writes nothing.
    expect(r.practitioner_notes).toBeNull();
    expect(state.updates[0].matched).toBe(0);
  });

  it("does not revalidate anything when nothing transitioned", async () => {
    state.rows = [submittedRow({ status: "in_progress", submitted_at: null })];
    await markIntakeReviewedAction(fd());
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // ISOLATES THE status PREDICATE. The ordinary in_progress fixture also has a
  // NULL submitted_at, so the submitted_at predicate alone would block it and
  // the status predicate could be deleted without this suite noticing (found by
  // negative control 1). This row is in_progress but DOES carry a submitted_at,
  // so ONLY `.eq("status","submitted")` can refuse it.
  it("an in_progress row that nonetheless carries a submitted_at is still blocked", async () => {
    state.rows = [
      submittedRow({
        status: "in_progress",
        submitted_at: "2026-07-01T10:00:00.000Z",
      }),
    ];
    const res = await markIntakeReviewedAction(fd());
    expect(res).toEqual({ ok: false, error: GENERIC });
    const r = row();
    expect(r.status).toBe("in_progress");
    expect(r.reviewed_at).toBeNull();
    expect(r.reviewed_by).toBeNull();
    expect(state.updates[0].matched).toBe(0);
  });

  // Same isolation for the already-reviewed case: a reviewed row has a
  // submitted_at, so only the status predicate stands between a second request
  // and an attribution rewrite.
  it("a reviewed row with a submitted_at is blocked by the status predicate alone", async () => {
    state.rows = [
      submittedRow({
        status: "reviewed",
        reviewed_at: "2026-07-02T09:00:00.000Z",
        reviewed_by: "prac-original",
      }),
    ];
    const res = await markIntakeReviewedAction(fd());
    expect(res).toEqual({ ok: false, error: GENERIC });
    expect(row().reviewed_by).toBe("prac-original");
    expect(state.updates[0].matched).toBe(0);
  });
});

describe("F-CLIN-004 / 3. submitted with a NULL submitted_at is blocked", () => {
  it("status says submitted but submitted_at is missing → refused", async () => {
    state.rows = [submittedRow({ submitted_at: null })];
    const res = await markIntakeReviewedAction(fd());
    expect(res).toEqual({ ok: false, error: GENERIC });
    const r = row();
    expect(r.status).toBe("submitted");
    expect(r.reviewed_at).toBeNull();
    expect(r.reviewed_by).toBeNull();
  });
});

describe("F-CLIN-004 / 4. an already-reviewed intake is blocked", () => {
  it("re-reviewing preserves the ORIGINAL attribution", async () => {
    state.rows = [
      submittedRow({
        status: "reviewed",
        reviewed_at: "2026-07-02T09:00:00.000Z",
        reviewed_by: "prac-original",
      }),
    ];
    const res = await markIntakeReviewedAction(fd());
    expect(res).toEqual({ ok: false, error: GENERIC });
    const r = row();
    expect(r.reviewed_at).toBe("2026-07-02T09:00:00.000Z");
    expect(r.reviewed_by).toBe("prac-original");
  });
});

describe("F-CLIN-004 / 5. same studio, different client is blocked", () => {
  it("a forged client_id cannot review another client's intake; BOTH rows unchanged", async () => {
    // The displayed route is CLIENT; the target intake belongs to OTHER_CLIENT.
    const target = submittedRow({ id: OTHER_INTAKE, client_id: OTHER_CLIENT });
    const displayed = submittedRow();
    state.rows = [displayed, target];

    const f = fd({ intake_id: OTHER_INTAKE, client_id: CLIENT });
    const res = await markIntakeReviewedAction(f);

    expect(res).toEqual({ ok: false, error: GENERIC });
    // Target intake untouched.
    expect(row(OTHER_INTAKE).status).toBe("submitted");
    expect(row(OTHER_INTAKE).reviewed_by).toBeNull();
    // Displayed intake untouched too: the action did not fall back to it.
    expect(row(INTAKE).status).toBe("submitted");
    expect(row(INTAKE).reviewed_by).toBeNull();
  });

  it("the reverse forge (real intake id, wrong route client) is also blocked", async () => {
    state.rows = [submittedRow()];
    const res = await markIntakeReviewedAction(fd({ client_id: OTHER_CLIENT }));
    expect(res).toEqual({ ok: false, error: GENERIC });
    expect(row().status).toBe("submitted");
    // Critically: no revalidation of the FORGED client route.
    expect(revalidatePath).not.toHaveBeenCalledWith(`/clients/${OTHER_CLIENT}`);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("F-CLIN-004 / 6. a different studio is blocked", () => {
  it("an intake in another studio cannot be reviewed", async () => {
    state.rows = [submittedRow({ studio_id: OTHER_STUDIO })];
    const res = await markIntakeReviewedAction(fd());
    expect(res).toEqual({ ok: false, error: GENERIC });
    expect(row().status).toBe("submitted");
    expect(row().reviewed_by).toBeNull();
  });

  it("the studio is taken from the session, never from FormData", async () => {
    state.rows = [submittedRow({ studio_id: OTHER_STUDIO })];
    // Even if a caller injects a studio_id field, it must be ignored.
    const f = fd();
    f.set("studio_id", OTHER_STUDIO);
    const res = await markIntakeReviewedAction(f);
    expect(res).toEqual({ ok: false, error: GENERIC });
    expect(row().status).toBe("submitted");
  });
});

describe("F-CLIN-004 / 7. a deleted intake is blocked", () => {
  it("a soft-deleted row is not reviewable", async () => {
    state.rows = [submittedRow({ deleted_at: "2026-07-05T00:00:00.000Z" })];
    const res = await markIntakeReviewedAction(fd());
    expect(res).toEqual({ ok: false, error: GENERIC });
    expect(row().status).toBe("submitted");
    expect(row().reviewed_by).toBeNull();
  });
});

describe("F-CLIN-004 / 8. a missing / nonexistent intake is blocked", () => {
  it("an unknown intake id reports the same generic failure", async () => {
    state.rows = [submittedRow()];
    const res = await markIntakeReviewedAction(fd({ intake_id: "no-such-id" }));
    expect(res).toEqual({ ok: false, error: GENERIC });
    expect(row().status).toBe("submitted");
  });

  it("an empty table reports the same generic failure (no existence oracle)", async () => {
    state.rows = [];
    const res = await markIntakeReviewedAction(fd());
    expect(res).toEqual({ ok: false, error: GENERIC });
  });
});

describe("F-CLIN-004 / 9. an inactive practitioner is blocked", () => {
  it("refuses before touching the database", async () => {
    getCurrentPractitionerWithStudio.mockResolvedValue({
      practitioner: { id: PRACTITIONER, active: false },
      studio: { id: STUDIO },
    });
    state.rows = [submittedRow()];
    const res = await markIntakeReviewedAction(fd());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Inactive practitioners/i);
    expect(row().status).toBe("submitted");
    expect(createClientSpy).not.toHaveBeenCalled();
  });
});

describe("F-CLIN-004 / 10-11. missing identifiers", () => {
  it("10. a missing intake_id is refused with no DB call", async () => {
    const f = fd();
    f.delete("intake_id");
    const res = await markIntakeReviewedAction(f);
    expect(res).toEqual({ ok: false, error: "Missing intake id." });
    expect(createClientSpy).not.toHaveBeenCalled();
  });

  it("11. a missing client_id is refused with no DB call", async () => {
    const f = fd();
    f.delete("client_id");
    const res = await markIntakeReviewedAction(f);
    expect(res).toEqual({ ok: false, error: "Missing client id." });
    expect(createClientSpy).not.toHaveBeenCalled();
  });

  it("an empty-string client_id is refused (not treated as a wildcard)", async () => {
    state.rows = [submittedRow()];
    const res = await markIntakeReviewedAction(fd({ client_id: "" }));
    expect(res).toEqual({ ok: false, error: "Missing client id." });
    expect(row().status).toBe("submitted");
  });
});

describe("F-CLIN-004 / 12. zero returned rows never reports success", () => {
  it("every blocked case returns ok:false AND matched exactly 0 rows", async () => {
    const cases: Array<[string, Row]> = [
      ["in_progress", submittedRow({ status: "in_progress", submitted_at: null })],
      ["null submitted_at", submittedRow({ submitted_at: null })],
      ["already reviewed", submittedRow({ status: "reviewed" })],
      ["wrong studio", submittedRow({ studio_id: OTHER_STUDIO })],
      ["wrong client", submittedRow({ client_id: OTHER_CLIENT })],
      ["deleted", submittedRow({ deleted_at: "2026-07-05T00:00:00.000Z" })],
    ];
    for (const [label, r] of cases) {
      state.rows = [r];
      state.updates = [];
      const res = await markIntakeReviewedAction(fd());
      expect(res, label).toEqual({ ok: false, error: GENERIC });
      expect(state.updates[0].matched, label).toBe(0);
    }
  });

  it("all six blocked reasons are byte-identical, no existence/ownership oracle", async () => {
    const messages = new Set<string>();
    const cases = [
      submittedRow({ status: "in_progress", submitted_at: null }),
      submittedRow({ submitted_at: null }),
      submittedRow({ status: "reviewed" }),
      submittedRow({ studio_id: OTHER_STUDIO }),
      submittedRow({ client_id: OTHER_CLIENT }),
      submittedRow({ deleted_at: "2026-07-05T00:00:00.000Z" }),
    ];
    for (const r of cases) {
      state.rows = [r];
      const res = await markIntakeReviewedAction(fd());
      if (!res.ok) messages.add(res.error);
    }
    // Also the "row does not exist at all" case.
    state.rows = [];
    const missing = await markIntakeReviewedAction(fd());
    if (!missing.ok) messages.add(missing.error);

    expect(messages.size).toBe(1);
    expect([...messages][0]).toBe(GENERIC);
  });
});

describe("F-CLIN-004 / 13. database errors are sanitized", () => {
  it("returns curated copy and never the raw provider message", async () => {
    state.rows = [submittedRow()];
    state.failWith = {
      message:
        'duplicate key value violates unique constraint "client_intake_forms_pkey" DETAIL: Key (id)=(intake-1) already exists.',
      code: "23505",
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await markIntakeReviewedAction(fd());
    spy.mockRestore();

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe(
        "Could not mark this intake reviewed. Please try again.",
      );
      // The raw Postgres text must not appear anywhere in the returned value.
      expect(res.error).not.toMatch(/duplicate key/i);
      expect(res.error).not.toMatch(/constraint/i);
      expect(res.error).not.toMatch(/23505/);
      expect(res.error).not.toMatch(/DETAIL/i);
    }
    expect(row().status).toBe("submitted");
  });

  it("logs the provider detail server-side only, with no client/intake identity", async () => {
    state.rows = [submittedRow()];
    state.failWith = { message: "permission denied for table", code: "42501" };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await markIntakeReviewedAction(fd());
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    expect(logged).toMatch(/intake_review_update_failed/);
    expect(logged).toMatch(/42501/);
    // No identifiers, no answers, no notes in the log line.
    expect(logged).not.toContain(CLIENT);
    expect(logged).not.toContain(INTAKE);
    expect(logged).not.toContain(PRACTITIONER);
    expect(logged).not.toContain("looks fine");
  });
});

describe("F-CLIN-004 / 14. concurrency: exactly one transition", () => {
  it("two concurrent requests produce one success and one safe failure", async () => {
    state.rows = [submittedRow()];
    const [a, b] = await Promise.all([
      markIntakeReviewedAction(fd()),
      markIntakeReviewedAction(fd()),
    ]);

    const oks = [a, b].filter((r) => r.ok);
    const fails = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
    expect(fails[0]).toEqual({ ok: false, error: GENERIC });

    // Exactly one transition happened.
    expect(row().status).toBe("reviewed");
    const matchedCounts = state.updates.map((u) => u.matched).sort();
    expect(matchedCounts).toEqual([0, 1]);
  });

  it("the second request does not rewrite the first request's attribution", async () => {
    state.rows = [submittedRow()];
    await markIntakeReviewedAction(fd());
    const firstAt = row().reviewed_at;
    const firstBy = row().reviewed_by;

    // A second practitioner, arriving later, must not overwrite the record.
    getCurrentPractitionerWithStudio.mockResolvedValue({
      practitioner: { id: "prac-second", active: true },
      studio: { id: STUDIO },
    });
    const res = await markIntakeReviewedAction(fd());

    expect(res).toEqual({ ok: false, error: GENERIC });
    expect(row().reviewed_at).toBe(firstAt);
    expect(row().reviewed_by).toBe(firstBy);
    expect(row().reviewed_by).not.toBe("prac-second");
  });
});

describe("F-CLIN-004 / 15. a stale submitted page settles safely", () => {
  it("a page rendered as submitted, reviewed elsewhere, fails safely without rewriting", async () => {
    state.rows = [submittedRow()];
    // Another request reviews it first.
    await markIntakeReviewedAction(fd());
    const attributedAt = row().reviewed_at;
    const attributedBy = row().reviewed_by;
    revalidatePath.mockClear();

    // The stale tab now submits its own review.
    const res = await markIntakeReviewedAction(fd());

    expect(res).toEqual({ ok: false, error: GENERIC });
    expect(row().reviewed_at).toBe(attributedAt);
    expect(row().reviewed_by).toBe(attributedBy);
    expect(row().status).toBe("reviewed");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("F-CLIN-004 / 16. browser-supplied review fields are ignored", () => {
  it("reviewed_by / reviewed_at / status / studio_id from FormData are never used", async () => {
    state.rows = [submittedRow()];
    const f = fd();
    f.set("reviewed_by", "attacker-practitioner");
    f.set("reviewed_at", "1999-01-01T00:00:00.000Z");
    f.set("status", "reviewed");
    f.set("studio_id", OTHER_STUDIO);

    const res = await markIntakeReviewedAction(f);
    expect(res).toEqual({ ok: true });

    const r = row();
    expect(r.reviewed_by).toBe(PRACTITIONER);
    expect(r.reviewed_by).not.toBe("attacker-practitioner");
    expect(r.reviewed_at).not.toBe("1999-01-01T00:00:00.000Z");
    expect(new Date(r.reviewed_at as string).getUTCFullYear()).toBeGreaterThan(
      2020,
    );
    expect(r.studio_id).toBe(STUDIO);

    // The patch itself must contain ONLY server-derived keys.
    expect(Object.keys(state.updates[0].patch).sort()).toEqual([
      "practitioner_notes",
      "reviewed_at",
      "reviewed_by",
      "status",
    ]);
  });

  it("the update never writes responses or submitted_at", async () => {
    state.rows = [submittedRow()];
    const f = fd();
    f.set("responses", JSON.stringify({ has_allergies: "no" }));
    f.set("submitted_at", "1999-01-01T00:00:00.000Z");
    await markIntakeReviewedAction(f);

    const patch = state.updates[0].patch;
    expect(patch).not.toHaveProperty("responses");
    expect(patch).not.toHaveProperty("submitted_at");
    expect(row().submitted_at).toBe("2026-07-01T10:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Notes action
// ---------------------------------------------------------------------------

const NOTES_GENERIC =
  "Could not save these notes. Refresh and check the current intake status.";

describe("F-CLIN-004 / notes action hardening", () => {
  it("saves for the exact same-client row (in_progress)", async () => {
    state.rows = [submittedRow({ status: "in_progress", submitted_at: null })];
    const res = await saveIntakeNotesAction(fd());
    expect(res).toEqual({ ok: true });
    expect(row().practitioner_notes).toBe("looks fine");
    // Product behaviour preserved: notes stay editable before submission.
    expect(row().status).toBe("in_progress");
  });

  it("saves for submitted and for reviewed rows too", async () => {
    for (const status of ["submitted", "reviewed"] as const) {
      state.rows = [submittedRow({ status })];
      const res = await saveIntakeNotesAction(fd());
      expect(res, status).toEqual({ ok: true });
      expect(row().practitioner_notes, status).toBe("looks fine");
      expect(row().status, status).toBe(status);
    }
  });

  it("a wrong client fails and writes nothing", async () => {
    state.rows = [submittedRow({ client_id: OTHER_CLIENT })];
    const res = await saveIntakeNotesAction(fd());
    expect(res).toEqual({ ok: false, error: NOTES_GENERIC });
    expect(row().practitioner_notes).toBeNull();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("a wrong studio fails and writes nothing", async () => {
    state.rows = [submittedRow({ studio_id: OTHER_STUDIO })];
    const res = await saveIntakeNotesAction(fd());
    expect(res).toEqual({ ok: false, error: NOTES_GENERIC });
    expect(row().practitioner_notes).toBeNull();
  });

  it("a deleted row fails and writes nothing", async () => {
    state.rows = [submittedRow({ deleted_at: "2026-07-05T00:00:00.000Z" })];
    const res = await saveIntakeNotesAction(fd());
    expect(res).toEqual({ ok: false, error: NOTES_GENERIC });
    expect(row().practitioner_notes).toBeNull();
  });

  it("a nonexistent row fails", async () => {
    state.rows = [];
    const res = await saveIntakeNotesAction(fd());
    expect(res).toEqual({ ok: false, error: NOTES_GENERIC });
  });

  it("zero returned rows is never reported as success", async () => {
    state.rows = [submittedRow({ client_id: OTHER_CLIENT })];
    const res = await saveIntakeNotesAction(fd());
    expect(res.ok).toBe(false);
    expect(state.updates[0].matched).toBe(0);
  });

  it("blank notes become NULL", async () => {
    state.rows = [submittedRow({ practitioner_notes: "old" })];
    await saveIntakeNotesAction(fd({ practitioner_notes: "" }));
    expect(row().practitioner_notes).toBeNull();
  });

  it("whitespace-only notes become NULL", async () => {
    state.rows = [submittedRow({ practitioner_notes: "old" })];
    await saveIntakeNotesAction(fd({ practitioner_notes: "   \n\t  " }));
    expect(row().practitioner_notes).toBeNull();
  });

  it("a non-empty value is trimmed", async () => {
    state.rows = [submittedRow()];
    await saveIntakeNotesAction(fd({ practitioner_notes: "  keep me  " }));
    expect(row().practitioner_notes).toBe("keep me");
  });

  it("status and every review field remain unchanged", async () => {
    state.rows = [
      submittedRow({
        status: "reviewed",
        reviewed_at: "2026-07-02T09:00:00.000Z",
        reviewed_by: "prac-original",
      }),
    ];
    await saveIntakeNotesAction(fd());
    const r = row();
    expect(r.status).toBe("reviewed");
    expect(r.submitted_at).toBe("2026-07-01T10:00:00.000Z");
    expect(r.reviewed_at).toBe("2026-07-02T09:00:00.000Z");
    expect(r.reviewed_by).toBe("prac-original");
    // The patch touches practitioner_notes and nothing else.
    expect(Object.keys(state.updates[0].patch)).toEqual(["practitioner_notes"]);
  });

  it("browser-supplied status / review fields are ignored", async () => {
    state.rows = [submittedRow({ status: "in_progress", submitted_at: null })];
    const f = fd();
    f.set("status", "reviewed");
    f.set("reviewed_by", "attacker-practitioner");
    f.set("reviewed_at", "1999-01-01T00:00:00.000Z");
    await saveIntakeNotesAction(f);
    const r = row();
    expect(r.status).toBe("in_progress");
    expect(r.reviewed_by).toBeNull();
    expect(r.reviewed_at).toBeNull();
  });

  it("a raw DB error is never returned", async () => {
    state.rows = [submittedRow()];
    state.failWith = {
      message: 'relation "public.client_intake_forms" does not exist',
      code: "42P01",
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await saveIntakeNotesAction(fd());
    spy.mockRestore();

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("Could not save these notes. Please try again.");
      expect(res.error).not.toMatch(/relation/i);
      expect(res.error).not.toMatch(/42P01/);
    }
  });

  it("missing identifiers are refused before any DB call", async () => {
    const noIntake = fd();
    noIntake.delete("intake_id");
    expect(await saveIntakeNotesAction(noIntake)).toEqual({
      ok: false,
      error: "Missing intake id.",
    });

    const noClient = fd();
    noClient.delete("client_id");
    expect(await saveIntakeNotesAction(noClient)).toEqual({
      ok: false,
      error: "Missing client id.",
    });

    expect(createClientSpy).not.toHaveBeenCalled();
  });

  it("an inactive practitioner cannot save notes", async () => {
    getCurrentPractitionerWithStudio.mockResolvedValue({
      practitioner: { id: PRACTITIONER, active: false },
      studio: { id: STUDIO },
    });
    state.rows = [submittedRow()];
    const res = await saveIntakeNotesAction(fd());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Inactive practitioners/i);
    expect(row().practitioner_notes).toBeNull();
    expect(createClientSpy).not.toHaveBeenCalled();
  });
});
