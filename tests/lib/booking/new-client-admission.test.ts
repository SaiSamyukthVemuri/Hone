import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const {
  resolveAdmission,
  newClientMayBook,
  newClientMayJoinWaitlist,
  isNewClientAdmissionMode,
  newClientAdmissionRefusesOutright,
} = await import("@/lib/booking/new-client-admission");
const { NEW_CLIENT_WAITLIST_SLUGS_ENV } = await import("@/lib/booking/new-client-waitlist");

// NEW-CLIENT-MODE-01 — the one admission authority.
//
// These exercise the PURE resolution, so every state is reachable without a
// database: the loader's only job is to hand this function a stored value, a
// read-failure flag and a server-resolved slug.

const ORIGINAL = process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
beforeEach(() => {
  delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
  else process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = ORIGINAL;
});

const R = (storedMode: string | null, readFailed = false, slug = "willow") =>
  resolveAdmission({ storedMode, readFailed, studioSlug: slug });

describe("the stored mode is the authority", () => {
  it.each(["open", "waitlist", "closed"] as const)("%s is returned as itself", (m) => {
    expect(R(m)).toEqual({ ok: true, mode: m, source: "persisted" });
  });

  it("a value outside the closed set is UNKNOWN, never a guess", () => {
    // The database CHECK makes this unreachable, so reaching it means the model
    // moved underneath us - exactly when guessing is worst.
    expect(R("paused")).toEqual({ ok: false });
    expect(R("OPEN")).toEqual({ ok: false });
    expect(isNewClientAdmissionMode("paused")).toBe(false);
  });
});

describe("UNKNOWN never becomes OPEN", () => {
  it("a failed read is unknown, not open", () => {
    expect(R(null, true)).toEqual({ ok: false });
    expect(R("open", true)).toEqual({ ok: false });
    // and the predicates refuse on it
    expect(newClientMayBook(R(null, true))).toBe(false);
    expect(newClientMayJoinWaitlist(R(null, true))).toBe(false);
  });

  it("a failed read is not CLOSED either - closure is a decision", () => {
    const a = R(null, true);
    expect(a.ok).toBe(false);
    expect(JSON.stringify(a)).not.toMatch(/closed/);
  });
});

describe("the transition bridge escalates ONLY", () => {
  it("a listed studio with no stored value is WAITLIST", () => {
    // Pre-0204 rows: the env is all there is.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "willow";
    expect(R(null)).toEqual({ ok: true, mode: "waitlist", source: "legacy_bridge" });
  });

  it("an unlisted studio with no stored value is OPEN", () => {
    expect(R(null)).toEqual({ ok: true, mode: "open", source: "legacy_bridge" });
  });

  it("the env escalates a stored OPEN to waitlist", () => {
    // During cutover a studio may still be listed while its row carries the
    // 0204 backfill default. It must stay on the waitlist.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "willow";
    expect(R("open")).toEqual({ ok: true, mode: "waitlist", source: "legacy_bridge" });
  });

  it("the env can NEVER de-escalate a stored waitlist or closed", () => {
    // The whole safety property. If this were two-way, a deploy that dropped a
    // slug would silently reopen a studio its owner had waitlisted or closed.
    expect(R("waitlist")).toEqual({ ok: true, mode: "waitlist", source: "persisted" });
    expect(R("closed")).toEqual({ ok: true, mode: "closed", source: "persisted" });
  });

  it("another studio's slug does not move THIS studio", () => {
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "some-other-studio";
    expect(R("open")).toEqual({ ok: true, mode: "open", source: "persisted" });
  });
});

describe("REGRESSION: removing a slug cannot quietly change the commitment", () => {
  it("once the DB says waitlist, dropping the env leaves it waitlist", () => {
    // The named regression: with the DB authority active, an env edit must not
    // move a studio off the durable path. `waitlist` means the durable row IS
    // the commitment, so this is what keeps submissions from becoming
    // email-only.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "willow";
    expect(R("waitlist")).toEqual({ ok: true, mode: "waitlist", source: "persisted" });
    delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
    expect(R("waitlist")).toEqual({ ok: true, mode: "waitlist", source: "persisted" });
  });

  it("there is no separate durable flag to fall out of step with the mode", () => {
    // WAIT-02 had a second env that chose durable-vs-email AFTER the gate said
    // yes, so the two could disagree. In this model `waitlist` IS durable, and
    // no second switch exists to drift.
    const src = new URL("../../../lib/booking/new-client-admission.ts", import.meta.url);
    expect(src.pathname).toMatch(/new-client-admission\.ts$/);
  });
});

describe("the predicates say exactly what they mean", () => {
  it("only OPEN may book", () => {
    expect(newClientMayBook({ ok: true, mode: "open", source: "persisted" })).toBe(true);
    expect(newClientMayBook({ ok: true, mode: "waitlist", source: "persisted" })).toBe(false);
    expect(newClientMayBook({ ok: true, mode: "closed", source: "persisted" })).toBe(false);
    expect(newClientMayBook({ ok: false })).toBe(false);
  });

  it("only WAITLIST may join - CLOSED refuses the join as well as the booking", () => {
    expect(newClientMayJoinWaitlist({ ok: true, mode: "waitlist", source: "persisted" })).toBe(true);
    expect(newClientMayJoinWaitlist({ ok: true, mode: "open", source: "persisted" })).toBe(false);
    expect(newClientMayJoinWaitlist({ ok: true, mode: "closed", source: "persisted" })).toBe(false);
    expect(newClientMayJoinWaitlist({ ok: false })).toBe(false);
  });
});

describe("P1: the reader actually reads, for an ANON public visitor", () => {
  // The defect: getNewClientAdmissionMode used the RLS-scoped client. `studios`
  // RLS is "members read" for authenticated only, so a public visitor got NO
  // ROW - reported by maybeSingle as { data: null, error: null }, not an error.
  // storedMode became null, the bridge answered, and a stored WAITLIST or
  // CLOSED silently went on taking bookings. Silent, because nothing failed.
  const STUDIO = { id: "studio-1", slug: "willow" };

  const withAdminRow = async (
    row: unknown,
    error: { code?: string; message?: string } | null = null,
  ) => {
    vi.resetModules();
    const calls: Array<{ table: string; cols: string; key: string; val: unknown }> = [];
    vi.doMock("@/lib/supabase/admin-server", () => ({
      createAdminClient: () => ({
        from: (table: string) => ({
          select: (cols: string) => ({
            eq: (key: string, val: unknown) => {
              calls.push({ table, cols, key, val });
              return { maybeSingle: async () => ({ data: row, error }) };
            },
          }),
        }),
      }),
    }));
    const mod = await import("@/lib/booking/new-client-admission");
    const result = await mod.getNewClientAdmissionMode(STUDIO);
    return { result, calls };
  };

  it("honours a stored OPEN on the public path", async () => {
    const { result } = await withAdminRow({ new_client_admission_mode: "open" });
    expect(result).toEqual({ ok: true, mode: "open", source: "persisted" });
  });

  it("a stored WAITLIST wins even when the legacy env does NOT list the studio", async () => {
    // The exact silent failure: absent from the env, stored as waitlist.
    delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
    const { result } = await withAdminRow({ new_client_admission_mode: "waitlist" });
    expect(result).toEqual({ ok: true, mode: "waitlist", source: "persisted" });
  });

  it("a stored CLOSED wins even when the legacy env does NOT list the studio", async () => {
    delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
    const { result } = await withAdminRow({ new_client_admission_mode: "closed" });
    expect(result).toEqual({ ok: true, mode: "closed", source: "persisted" });
  });

  it("a NON-column read failure is UNKNOWN, never a fallback", async () => {
    const { result } = await withAdminRow(null, {
      code: "57014",
      message: "canceling statement due to statement timeout",
    });
    expect(result).toEqual({ ok: false });
  });

  it("a pre-0204 MISSING COLUMN falls through to the bridge, not to unknown", async () => {
    // Migration-order safety: the deployed app must keep working before 0204.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "willow";
    const { result } = await withAdminRow(null, {
      code: "42703",
      message: 'column studios.new_client_admission_mode does not exist',
    });
    expect(result).toEqual({ ok: true, mode: "waitlist", source: "legacy_bridge" });
  });

  it("reads ONE column, keyed by the SERVER-RESOLVED studio id", async () => {
    const { calls } = await withAdminRow({ new_client_admission_mode: "open" });
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("studios");
    // Not `select("*")`: no other studio column is exposed by this read.
    expect(calls[0].cols).toBe("new_client_admission_mode");
    // The id, never the slug - a slug is what a browser could try to influence.
    expect(calls[0].key).toBe("id");
    expect(calls[0].val).toBe("studio-1");
  });
});

// ===========================================================================
// ANTI-COLLAPSE CONTRACT — exact-head P1 at be6722b7.
//
// `app/book/[slug]/actions.ts` gated new-client booking on ONE boolean,
// `admissionGateApplies = !newClientMayBook(admission)`, which is true for
// `waitlist`, `closed` AND an unreadable mode alike. The branch it guarded then
// let any successfully authorized invitation continue, so an invitation issued
// while a studio was WAITLISTED went on booking after the owner switched to
// CLOSED, and booked identically when the admission read FAILED.
//
// One boolean cannot express this authority. It takes two, and this file is
// where that is pinned.
// ===========================================================================
describe("the four admission states cannot collapse into one boolean", () => {
  const OPEN = { ok: true, mode: "open", source: "persisted" } as const;
  const WAITLIST = { ok: true, mode: "waitlist", source: "persisted" } as const;
  const CLOSED = { ok: true, mode: "closed", source: "persisted" } as const;
  const UNKNOWN = { ok: false } as const;

  it("newClientMayBook admits ONLY open", () => {
    expect(newClientMayBook(OPEN)).toBe(true);
    for (const state of [WAITLIST, CLOSED, UNKNOWN]) {
      expect(newClientMayBook(state)).toBe(false);
    }
  });

  it("newClientAdmissionRefusesOutright separates waitlist from closed/unknown", () => {
    // THE WHOLE POINT. `mayBook` is false for all three non-ordinary states, so
    // it cannot tell the one with an invitation exception from the two without.
    expect(newClientMayBook(WAITLIST)).toBe(newClientMayBook(CLOSED));
    // The second predicate must, and does.
    expect(newClientAdmissionRefusesOutright(WAITLIST)).toBe(false);
    expect(newClientAdmissionRefusesOutright(CLOSED)).toBe(true);
    expect(newClientAdmissionRefusesOutright(UNKNOWN)).toBe(true);
    expect(newClientAdmissionRefusesOutright(OPEN)).toBe(false);
  });

  it("an UNREADABLE mode is refused outright, never treated as open", () => {
    // The class this PR got wrong three times: absence of proof read as
    // permission. A failed read must not be recoverable by presenting
    // credentials.
    expect(newClientAdmissionRefusesOutright(UNKNOWN)).toBe(true);
    expect(newClientMayBook(UNKNOWN)).toBe(false);
    expect(newClientMayJoinWaitlist(UNKNOWN)).toBe(false);
  });

  it("the public booking action refuses BEFORE it can authorise an invitation", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const code = readFileSync(
      join(process.cwd(), "app/book/[slug]/actions.ts"),
      "utf8",
    );

    // It must consult the two-predicate authority, not a lone boolean.
    expect(code).toContain("newClientAdmissionRefusesOutright(admission)");

    // ORDER IS THE CONTRACT. The outright refusal must be returned before the
    // invitation authority can run, or a valid invitation becomes an admission
    // bypass again and an invitation is consumed on a path that cannot book.
    const refusal = code.indexOf("newClientAdmissionRefusesOutright(admission)");
    const authorize = code.indexOf("await authorizeInvitationForBooking(");
    expect(refusal).toBeGreaterThan(-1);
    expect(authorize).toBeGreaterThan(-1);
    expect(
      refusal,
      "the closed/unknown refusal must precede invitation authorisation",
    ).toBeLessThan(authorize);

    // And it must be scoped to NEW clients only — existing clients are outside
    // this authority entirely.
    const guard = code.slice(refusal - 200, refusal + 40);
    expect(guard).toContain('clientType === "new"');
  });
});
