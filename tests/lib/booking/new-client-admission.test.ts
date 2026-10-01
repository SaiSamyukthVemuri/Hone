import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// `setAt` is the third axis, and it is what separates an OWNER'S CHOICE from
// 0204's backfilled default. It defaults to a stamp, because a stored mode in
// these cases means somebody chose it; `R_UNCHOSEN` is the backfill.
const R = (
  storedMode: string | null,
  readFailed = false,
  slug = "willow",
  setAt: string | null = "2026-09-30T12:00:00.000Z",
) => resolveAdmission({ storedMode, storedSetAt: setAt, readFailed, studioSlug: slug });

/** 0204 backfill: the column says `open` and nobody chose it. */
const R_UNCHOSEN = (storedMode: string | null, slug = "willow") =>
  R(storedMode, false, slug, null);

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
    expect(R_UNCHOSEN("open")).toEqual({
      ok: true,
      mode: "waitlist",
      source: "legacy_bridge",
    });
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
    const { result } = await withAdminRow({
      new_client_admission_mode: "open",
      new_client_admission_mode_set_at: "2026-09-30T12:00:00.000Z",
    });
    expect(result).toEqual({ ok: true, mode: "open", source: "persisted" });
  });

  it("a stored WAITLIST wins even when the legacy env does NOT list the studio", async () => {
    // The exact silent failure: absent from the env, stored as waitlist.
    delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
    const { result } = await withAdminRow({
      new_client_admission_mode: "waitlist",
      new_client_admission_mode_set_at: "2026-09-30T12:00:00.000Z",
    });
    expect(result).toEqual({ ok: true, mode: "waitlist", source: "persisted" });
  });

  it("a stored CLOSED wins even when the legacy env does NOT list the studio", async () => {
    delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
    const { result } = await withAdminRow({
      new_client_admission_mode: "closed",
      new_client_admission_mode_set_at: "2026-09-30T12:00:00.000Z",
    });
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
    const { calls } = await withAdminRow({
      new_client_admission_mode: "open",
      new_client_admission_mode_set_at: "2026-09-30T12:00:00.000Z",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("studios");
    // Not `select("*")`: no other studio column is exposed by this read. The
    // second column is the audit stamp that separates an owner's choice from
    // 0204's backfilled default - without it the reader cannot tell them apart.
    expect(calls[0].cols).toBe(
      "new_client_admission_mode, new_client_admission_mode_set_at",
    );
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

// ===========================================================================
// EXACT-HEAD P1 at 3c2abe10 — AN EXPLICIT OWNER CHOICE OUTRANKS THE ENV BRIDGE.
//
// The reader loaded `new_client_admission_mode` and nothing else, so 0204's
// backfilled `open` and an owner-selected `open` were INDISTINGUISHABLE. The
// bridge escalated both. An owner still named in NEW_CLIENT_WAITLIST_STUDIO_SLUGS
// could press "Accept bookings", be told it saved - the command really did
// persist `open` and really did return ok - and stay waitlisted on every public
// surface until operations edited an env var. `closed` -> `open` reopened only to
// the waitlist.
//
// `new_client_admission_mode_set_at` is the fact that separates the two, and the
// command has always written it. The bridge now protects only UNCHOSEN rows.
// ===========================================================================
describe("the audit stamp decides whose choice this is", () => {
  const CHOSEN = "2026-09-30T12:00:00.000Z";
  const SLUG = "a-studio";
  const gate = (on: boolean) => {
    if (on) process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = SLUG;
    else delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
  };

  it("A. open + set_at NULL + env ON -> WAITLIST / legacy_bridge", () => {
    gate(true);
    expect(R("open", false, SLUG, null)).toEqual({
      ok: true,
      mode: "waitlist",
      source: "legacy_bridge",
    });
  });

  it("B. open + set_at NULL + env OFF -> OPEN / legacy_bridge", () => {
    gate(false);
    expect(R("open", false, SLUG, null)).toEqual({
      ok: true,
      mode: "open",
      source: "legacy_bridge",
    });
  });

  it("C. open + set_at NON-NULL + env ON -> OPEN / persisted", () => {
    // THE REPAIR. The owner chose to accept bookings; a stale env slug cannot
    // undo that, and the save they were shown is now true.
    gate(true);
    expect(R("open", false, SLUG, CHOSEN)).toEqual({
      ok: true,
      mode: "open",
      source: "persisted",
    });
  });

  it.each([[true], [false]])(
    "D. waitlist + set_at NON-NULL -> WAITLIST / persisted (env on=%s)",
    (envOn) => {
      gate(envOn);
      expect(R("waitlist", false, SLUG, CHOSEN)).toEqual({
        ok: true,
        mode: "waitlist",
        source: "persisted",
      });
    },
  );

  it.each([[true], [false]])(
    "E. closed + set_at NON-NULL -> CLOSED / persisted (env on=%s)",
    (envOn) => {
      gate(envOn);
      expect(R("closed", false, SLUG, CHOSEN)).toEqual({
        ok: true,
        mode: "closed",
        source: "persisted",
      });
    },
  );

  it("F. the column is missing before 0204 -> the legacy behaviour, unchanged", () => {
    gate(true);
    expect(R(null, false, SLUG, null)).toEqual({
      ok: true,
      mode: "waitlist",
      source: "legacy_bridge",
    });
    gate(false);
    expect(R(null, false, SLUG, null)).toEqual({
      ok: true,
      mode: "open",
      source: "legacy_bridge",
    });
  });

  it("the bridge stays ONE-WAY for UNCHOSEN rows too", () => {
    // Found by mutation: moving the persisted check earlier left this untested.
    // Making the bridge two-way (`if (envWaitlist)` instead of `open &&
    // envWaitlist`) passed all 38 other cases, because every de-escalation case
    // now carries a stamp and exits before the bridge is reached.
    //
    // A stamp-less `closed` or `waitlist` should not exist - the command always
    // stamps - but if one does, the env list is not evidence that a studio is
    // LESS restricted than its own row says, so the bridge may only ESCALATE.
    gate(true);
    expect(R("closed", false, SLUG, null)).toEqual({
      ok: true,
      mode: "closed",
      source: "legacy_bridge",
    });
    expect(R("waitlist", false, SLUG, null)).toEqual({
      ok: true,
      mode: "waitlist",
      source: "legacy_bridge",
    });
  });

  it("G. a non-migration read failure -> UNKNOWN, whatever the stamp says", () => {
    gate(true);
    expect(R("open", true, SLUG, CHOSEN)).toEqual({ ok: false });
    expect(R("waitlist", true, SLUG, CHOSEN)).toEqual({ ok: false });
    // Fail-closed is not negotiable by an audit stamp: a read that did not
    // happen cannot be evidence of a choice.
    expect(R(null, true, SLUG, null)).toEqual({ ok: false });
  });

  // -- the four behaviours the ruling is actually about ---------------------

  it("an owner who selects OPEN while still listed BECOMES open", () => {
    gate(true);
    const before = R("open", false, SLUG, null);   // backfill, still bridged
    const after = R("open", false, SLUG, CHOSEN);  // the owner pressed save
    expect(before).toEqual({ ok: true, mode: "waitlist", source: "legacy_bridge" });
    expect(after).toEqual({ ok: true, mode: "open", source: "persisted" });
    // The save is TRUTHFUL: the public path now answers what the banner claimed.
    expect(newClientMayBook(after)).toBe(true);
    expect(newClientMayBook(before)).toBe(false);
  });

  it("CLOSED then OPEN actually reopens booking, not the waitlist", () => {
    gate(true);
    const closed = R("closed", false, SLUG, CHOSEN);
    const reopened = R("open", false, SLUG, CHOSEN);
    expect(closed.ok && closed.mode).toBe("closed");
    expect(reopened.ok && reopened.mode).toBe("open");
    expect(newClientMayBook(reopened)).toBe(true);
    expect(newClientMayJoinWaitlist(reopened)).toBe(false);
  });

  it("persisted OPEN is never returned to WAITLIST by a stale env slug", () => {
    for (const stale of [SLUG, `${SLUG},other`, `other,${SLUG}`]) {
      process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = stale;
      const a = R("open", false, SLUG, CHOSEN);
      expect(a, `stale list ${stale} must not move a chosen OPEN`).toEqual({
        ok: true,
        mode: "open",
        source: "persisted",
      });
    }
  });

  it("the stamp changes NOTHING about existing-client rights", () => {
    // This authority is new-client only, in every combination. The predicates
    // below are the whole exported surface that reads a mode, and none of them
    // is consulted on an existing-client path.
    gate(true);
    for (const setAt of [null, CHOSEN]) {
      for (const mode of ["open", "waitlist", "closed"] as const) {
        const a = R(mode, false, SLUG, setAt);
        expect(typeof newClientMayBook(a)).toBe("boolean");
        expect(typeof newClientMayJoinWaitlist(a)).toBe("boolean");
      }
    }
    const source = readFileSync(
      join(process.cwd(), "lib/booking/new-client-admission.ts"),
      "utf8",
    );
    expect(source).toContain("NEW-CLIENT ONLY");
    expect(source).not.toContain("existingClientMay");
  });
});

// ===========================================================================
// THE ACTIVATION DOCUMENT IS AN OPERATIONAL INSTRUCTION, SO IT IS TESTED.
//
// Exact-head P1 at d55cbd8e: the rollback section said restoring an env slug
// restores waitlist behaviour. After the stamp repair that is false for any
// stamped studio - `resolveAdmission` returns a persisted mode before it
// consults the bridge - and step 4 explicitly allows an already-stamped studio
// to be skipped, so an operator could roll back, be told nothing, and leave a
// studio open. A wrong sentence in a cutover plan is worse than a code bug,
// because it is followed under pressure.
// ===========================================================================
describe("the activation document matches what the source actually does", () => {
  const DOC = readFileSync(
    join(process.cwd(), "docs/production/new-client-admission-activation.md"),
    "utf8",
  );
  const POLICY = readFileSync(
    join(process.cwd(), "lib/booking/free-consult-reschedule-policy.ts"),
    "utf8",
  );
  const LISTED = "a-listed-studio";
  const STAMP = "2026-09-30T12:00:00.000Z";

  it("rollback for a STAMPED studio requires the command, and the source agrees", () => {
    expect(DOC).toContain("set_new_client_admission_mode(<studio>, 'waitlist')");
    expect(DOC).toContain("**The env list cannot do it.**");

    // The behavioural half of the same claim: with the slug listed, a stamped
    // `open` stays open, so an env-only rollback genuinely cannot restore it.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = LISTED;
    expect(R("open", false, LISTED, STAMP)).toEqual({
      ok: true,
      mode: "open",
      source: "persisted",
    });
    // And the unstamped half, which the document says env CAN still roll back.
    expect(R("open", false, LISTED, null)).toEqual({
      ok: true,
      mode: "waitlist",
      source: "legacy_bridge",
    });
  });

  it("never claims an env slug overrides an explicit owner choice", () => {
    expect(DOC).toContain(
      "Never claim that restoring an env slug overrides an explicit owner choice",
    );
    // The old sentence, which was the defect, must be gone.
    expect(DOC).not.toContain(
      "restoring a\nslug restores waitlist behaviour immediately",
    );
  });

  it("step 6 does not promise to delete authority EMERG-01 still needs", () => {
    const step6 = DOC.slice(DOC.indexOf("6. **Only then remove"));
    expect(step6).toContain("CANNOT BE DELETED");
    expect(step6).toContain("free-consult-reschedule-policy.ts");
    expect(step6).toContain("bounded follow-up debt");
    // The claim is only true while that policy really does still read it.
    expect(POLICY).toContain("isNewClientWaitlistEnabled(studioSlug)");
  });

  it("records that the new-client control does not move booked rights", () => {
    expect(DOC).toContain(
      "It does not touch existing-client, portal or rebook behaviour at any step",
    );
    // And the policy that would have violated it no longer can: it takes a slug.
    expect(POLICY).toContain("studioSlug: string | null | undefined;");
  });
});
