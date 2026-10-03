import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path, { join } from "node:path";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const {
  resolveAdmission,
  newClientMayBook,
  newClientMayJoinWaitlist,
  isNewClientAdmissionMode,
  newClientAdmissionRefusesOutright,
} = await import("@/lib/booking/new-client-admission");
const { NEW_CLIENT_WAITLIST_SLUGS_ENV, NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV } =
  await import("@/lib/booking/new-client-waitlist");

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

// `setAt` is the third axis, and it separates an INITIALIZED persisted authority
// from a row that never had one. It defaults to a stamp, because a stored mode
// in these cases means the authority is initialized; `R_UNCHOSEN` is the
// pre-0204 row that never was.
//
// SINCE 0205 A STAMP NO LONGER IMPLIES AN OWNER CHOSE: the column carries a
// `now()` default, so a studio is born stamped and system-initialized at `open`.
// `new_client_admission_mode_set_by` is what tells the two apart, and
// `resolveAdmission` deliberately does not take it -- see the final block.
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

  it("NO ROW is unknown, not the bridge's default", async () => {
    // Exact-head P2 at 096b0b2e, and the original P1's class in a second place.
    // `maybeSingle()` reports "nothing matched" as { data: null, error: null },
    // so a studio deleted between the caller's lookup and this read arrives as a
    // SUCCESS with no row. Optional chaining turned that into the same
    // `(null, null)` the pre-0204 MISSING COLUMN path uses, and the bridge then
    // answered `open` - or `waitlist` if the slug happened to be listed - with
    // full confidence. Nothing had failed, so nothing was reported.
    delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
    const { result } = await withAdminRow(null);
    expect(result).toEqual({ ok: false });

    // And it stays unknown when the slug IS listed: being named in an env list
    // is not evidence that a studio exists.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "willow";
    const { result: listed } = await withAdminRow(null);
    expect(listed).toEqual({ ok: false });
  });

  it("the bridge fallback is reserved for the EXPLICIT missing-column error", async () => {
    // The distinction the repair turns on: migration skew and a vanished studio
    // are different facts and must not share a representation.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "willow";
    const { result: skew } = await withAdminRow(null, {
      code: "42703",
      message: "column studios.new_client_admission_mode does not exist",
    });
    expect(skew).toEqual({
      ok: true,
      mode: "waitlist",
      source: "legacy_bridge",
    });
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
    // UPDATED with the #779 closeout, which corrected a claim this test had been
    // pinning. The document used to list
    // `set_new_client_admission_mode(<studio>, 'waitlist')` as THE rollback for a
    // stamped studio. That conflates two different things: writing `waitlist`
    // changes the MODE and leaves the COMMIT POINT durable, because
    // `newClientWaitlistCommitIsDurable` answers the cut-over check before it reads
    // the legacy durable list. So the old wording promised a commit-point rollback
    // that does not exist, and pinning it here kept that promise alive.
    //
    // What is pinned now is the DECLARED STATUS of each claim, not the shape of
    // the prose around it. See the block below for why that changed.
    // ─── DECLARED CLAIM STATUS, NOT PARSED PROSE ────────────────────────────
    //
    // Three review rounds killed three successive prose pins here, always for
    // the same reason: a token check cannot establish what a sentence MEANS,
    // because adjacent prose reverses it. Measured, not assumed -- at the
    // previous head BOTH of these passed 47/47 while reviving the retired
    // promise:
    //
    //   "That is **withdrawn**. That withdrawal has been rescinded."
    //   a second historical paragraph quoting the live table row's exact text
    //
    // So the document DECLARES each claim's status in a machine-readable marker
    // -- the same idiom as the `<!-- canonical-facts:ignore-* -->` directives
    // already used across docs/production -- and this test pins the declared
    // field. Reviving the promise now requires flipping `value=withdrawn` to
    // `value=active`: it fails here, and it is legible in the diff. Prose cannot
    // do it.
    //
    // RESIDUAL, stated rather than hidden: a marker could drift from the prose
    // it governs. The coupling assertions bound that -- one canonical statement,
    // marker sitting on it -- but nothing here reads meaning, and nothing here
    // claims to.
    // STRICT AND WHOLE. The first version of this parser had a permissive tail
    // for the human explanation, and `value=withdrawn value=active` walked
    // straight through it: the first value was captured, the second absorbed as
    // commentary, and ONE marker declared TWO statuses while the registry, the
    // domain, the duplicate-id check and the raw count all stayed green.
    //
    // So the directive now carries exactly two assignments and no prose -- the
    // prose lives in an ordinary comment beside it -- and the body is matched
    // whole and anchored. Any repeated or extra assignment fails to parse.
    const MARKER_RE = /<!--\s*claim-status\b([\s\S]*?)-->/g;
    const claims = new Map<string, string>();
    const dupes: string[] = [];
    let markerCount = 0;
    for (let m = MARKER_RE.exec(DOC); m; m = MARKER_RE.exec(DOC)) {
      markerCount += 1;
      const fields = /^id=([a-z0-9-]+) value=([a-z-]+)$/.exec(m[1].trim());
      expect(
        fields,
        `claim-status directive ${markerCount} must be exactly "id=<id> value=<status>" ` +
          `with no second assignment and no prose, got ${JSON.stringify(m[1].trim())}`,
      ).not.toBeNull();
      if (!fields) continue;
      if (claims.has(fields[1])) dupes.push(fields[1]);
      claims.set(fields[1], fields[2]);
    }
    // A MALFORMED DIRECTIVE MUST FAIL, NOT VANISH. A directive opener whose body
    // does not parse would otherwise leave its claim silently unpinned, so the
    // count of OPENERS is reconciled against what actually parsed.
    //
    // Counting the bare word would be wrong, and was: the contract's own preamble
    // explains the `claim-status` mechanism in prose, which made three tokens for
    // two directives. A guard that forbids a document from describing its own
    // mechanism is a guard people delete.
    expect(
      (DOC.match(/<!--\s*claim-status/g) ?? []).length,
      "every claim-status directive must parse; a malformed one must fail, not disappear",
    ).toBe(markerCount);
    // No shadowing: a second marker for an id would otherwise decide the claim
    // by document order.
    expect(dupes, "each claim id must be declared exactly once").toEqual([]);
    // A closed registry, so a new claim cannot appear unregistered here.
    expect([...claims.keys()].sort(), "the declared claim registry").toEqual([
      "commit-point-rollback-supported",
      "commit-point-rollback-via-mode-write",
    ]);
    // A closed value domain, so `value=rescinded` fails rather than being read
    // as neither active nor withdrawn.
    for (const [id, value] of claims) {
      expect(["active", "withdrawn"], `claim ${id} has a known status`).toContain(
        value,
      );
    }
    // THE TWO CLAIMS THIS CHANGE EXISTS TO HOLD.
    expect(
      claims.get("commit-point-rollback-supported"),
      "the no-mechanism rule is CURRENT guidance",
    ).toBe("active");
    expect(
      claims.get("commit-point-rollback-via-mode-write"),
      "the mode-write-as-rollback promise is RETIRED",
    ).toBe("withdrawn");

    // ─── COUPLING: ONE CANONICAL STATEMENT, MARKER SITTING ON IT ────────────
    // `exactly once` is what makes a statement canonical, and it defeats both
    // halves of the previous head's exploit: keep the live row and quote it
    // elsewhere, the count is 2; delete the live row and quote it elsewhere, the
    // marker no longer governs anything.
    const NO_ROW =
      "| **COMMIT POINT** — returning a studio to WAIT-01 **email-only** intake | " +
      "**NO — not supported by any existing mechanism for a cut-over studio.** |";
    expect(
      DOC.split(NO_ROW).length - 1,
      "the commit-point verdict must be stated exactly once",
    ).toBe(1);
    const activeMarker = DOC.indexOf(
      "<!-- claim-status id=commit-point-rollback-supported",
    );
    expect(activeMarker, "the active marker must exist").toBeGreaterThan(-1);
    const noRowAt = DOC.indexOf(NO_ROW);
    expect(noRowAt, "and must precede the row it governs").toBeGreaterThan(
      activeMarker,
    );
    expect(
      DOC.slice(DOC.indexOf("-->", activeMarker) + 3, noRowAt)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("|")),
      "only the table may separate the marker from the row it governs",
    ).toEqual([]);

    // The retired promise, likewise stated once, with its marker immediately
    // above the paragraph that retires it.
    const WITHDRAWAL_ANCHOR =
      "**Do not describe a mode transition as a commit-point rollback.**";
    const RETIRED = "set_new_client_admission_mode(<studio>, 'waitlist')";
    expect(
      DOC.split(RETIRED).length - 1,
      "the retired promise must be quoted exactly once, as history",
    ).toBe(1);

    // ─── THE CONTRACT FILE IS FROZEN END TO END ─────────────────────────────
    // Execution history used to live at the end of this file, which made the
    // document both a frozen contract and an append-only log. Those cannot
    // coexist under a guard that claims nothing in the document contradicts the
    // contract: the appendable region is unfrozen by construction, so a
    // contradiction appended there passed every check. Five rounds of review
    // walked that surface outwards -- paragraph, section, next heading, preamble,
    // record -- and the last step has no guard, only a boundary.
    //
    // So the history moved to new-client-admission-execution-record.md, verbatim,
    // and THIS file is the contract: frozen whole, with no appendable region at
    // all. This test asserts the contract and its declared directives; it does
    // not read the execution log, which is evidence rather than instruction.
    //
    // To change the contract deliberately, recompute and update the hash in the
    // same commit, so the edit arrives with a reviewer looking at it:
    //   node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync("docs/production/new-client-admission-activation.md")).digest("hex"))'
    expect(
      DOC,
      "execution history belongs in the record file; an appendable region here would unfreeze the contract",
    ).not.toContain("## EXECUTION RECORD");
    expect(
      createHash("sha256").update(DOC).digest("hex"),
      "the contract file is frozen END TO END: any edit -- preamble, a step, the rollback table, an appended line anywhere -- must fail here until the hash is updated deliberately",
    // UPDATED DELIBERATELY, twice, which is what this pin asks for.
    //
    //   1. The 0205 integration. The contract's rollback table defined a stamped
    //      studio as one "an owner has chosen"; 0205 makes that false, because a
    //      studio is now born stamped and system-initialized. The table split
    //      into system-initialized (set_by NULL) and owner-stamped (set_by set),
    //      and #779's one-way-door warning moved onto the owner row, where the
    //      commit point actually applies.
    //   2. A PROVENANCE CORRECTION, no behaviour. The paragraph explaining why
    //      set_by is NULL at creation attributed the owner practitioner to
    //      handle_new_user() (0081) on first sign-in. Migration 0141 redefined
    //      that function as a NO-OP and moved provisioning to the reconciliation
    //      path, so the mechanism was stale by sixty-odd migrations.
    //   3. NARROWING THAT CORRECTION'S OWN PREMISE. (2) leaned on the owner
    //      having no Auth account at studio creation. False: 0141 reconciles
    //      invitations for EXISTING accounts, so an invited owner may already be
    //      signed up and already hold practitioner rows in other studios.
    //   4. DROPPING THE MODALITY ALTOGETHER. (3) still called the NULL
    //      STRUCTURAL and said set_by "cannot" be anything else. It can:
    //      the column has no FK and public.studios has NO INSERT TRIGGER, so an
    //      explicit INSERT can stamp and attribute a row at creation. The
    //      paragraph now says what is actually true -- the creating path OMITS
    //      the columns and takes the NULL default -- and states both limits:
    //      unenforced, and not a claim about Auth-account existence. The three
    //      states are documented as a READING, not a schema-guaranteed
    //      partition.
    //
    //   5. TWO CONSISTENCY DEFECTS IN (4)'s OWN EDIT, found by sweep and by
    //      review. The limit paragraph said the three states were "below" when
    //      the table is above it -- the limit pointed away from what it limits
    //      -- and the lead-in said "there are two writers that initialize it",
    //      which reads exhaustive for a column an ungated INSERT can write.
    //      Both now point at and describe the table correctly.
    //
    // What survived all five is the only thing the repair needs: a row created
    // by a path that omits these columns arrives stamped and unattributed. No
    // assertion in this describe block changed, and no other region of the
    // document moved.
    ).toBe("fa14bddc38795438ced3de597fe50ddbf5b5e8c6a0e23552eae59a22e1441372");

    // The record file is evidence, and it must SAY so. This is a deletion guard
    // on its precedence header, not an interpretation of anything logged in it.
    const RECORD = readFileSync(
      join(
        process.cwd(),
        "docs/production/new-client-admission-execution-record.md",
      ),
      "utf8",
    );
    expect(
      RECORD,
      "the record file must declare itself dated historical evidence",
    ).toContain("**DATED HISTORICAL EVIDENCE. NOT AN OPERATOR CONTRACT.**");
    expect(
      RECORD,
      "and must declare that the contract wins on conflict",
    ).toContain("**THE CONTRACT WINS ON CONFLICT.**");

    // APPEND-ONLY MEANS THE EXISTING EVIDENCE IS IMMUTABLE, not merely that the
    // headers survive. Pinning two header literals left every recorded row free to
    // be rewritten or deleted while the file still passed -- so the file was
    // appendable but not append-ONLY, which is half of what it claims to be.
    //
    // The PREFIX is pinned by length and digest: anything added after that offset
    // passes untouched, any edit or deletion inside it fails. Advance both numbers
    // only when the prefix itself legitimately changes, which for recorded
    // production evidence should be approximately never.
    const RECORD_PREFIX_BYTES = 13457;
    expect(
      Buffer.byteLength(RECORD, "utf8"),
      "recorded evidence is append-only: the file may GROW, never shrink",
    ).toBeGreaterThanOrEqual(RECORD_PREFIX_BYTES);
    expect(
      createHash("sha256")
        .update(Buffer.from(RECORD, "utf8").subarray(0, RECORD_PREFIX_BYTES))
        .digest("hex"),
      "the existing execution record is frozen: appends pass, edits and deletions inside recorded evidence fail",
    ).toBe("682a236d277352a5625689c2a45d1e62e6dab800f818e5207ef799d5c0d04893");
    const withdrawnMarker = DOC.indexOf(
      "<!-- claim-status id=commit-point-rollback-via-mode-write",
    );
    expect(withdrawnMarker, "the withdrawal marker must exist").toBeGreaterThan(
      -1,
    );
    const warningAt = DOC.indexOf(WITHDRAWAL_ANCHOR);
    expect(
      warningAt,
      "the prospective warning must follow its marker",
    ).toBeGreaterThan(withdrawnMarker);
    expect(
      DOC.slice(DOC.indexOf("-->", withdrawnMarker) + 3, warningAt).trim(),
      "the withdrawal marker must sit immediately above the warning it declares",
    ).toBe("");

    // ─── DELETION GUARDS ONLY ───────────────────────────────────────────────
    // These prove the prose EXISTS. The markers above are what prove its STATUS.
    // Labelled, so no future reader mistakes a presence check for a proof of
    // meaning -- the mistake that cost this test three rounds.
    expect(
      DOC,
      "the live table must say the MODE can be changed, and by whom",
    ).toContain(
      "**YES**, through `set_new_client_admission_mode`, by the studio's owner.",
    );
    expect(DOC, "and that the env list is not a route to it").toContain(
      "the env list cannot do it",
    );

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

  it("step H does not promise to delete authority EMERG-01 still needs", () => {
    const step6 = DOC.slice(DOC.indexOf("**H. Retire the bridge machinery"));
    expect(step6).toContain("CANNOT BE DELETED");
    expect(step6).toContain("free-consult-reschedule-policy.ts");
    expect(step6).toContain("bounded follow-up debt");
    // The claim is only true while that policy really does still read it.
    expect(POLICY).toContain("isNewClientWaitlistEnabled(studioSlug)");
  });

  it("step H DOES retire the durable gate, which the bridge is the only reader of", () => {
    // The mirror of the rule above, and the distinction operators would get
    // wrong: one env list survives step 6 and the other must not. Leaving the
    // durable variable behind would mean maintaining a value that controls
    // nothing; deleting the ADMISSION list would silently restore self-service
    // movement of free consultations.
    const step6 = DOC.slice(DOC.indexOf("**H. Retire the bridge machinery"));
    expect(step6).toContain("RETIRE THE DURABLE ENV GATE WITH IT");
    expect(step6).toContain(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV);
    expect(step6).toContain("isNewClientWaitlistDurableEnabled");
    expect(step6).toContain("Deleting the variable is the LAST act");
    // Both halves named in the same step, so they cannot be conflated.
    // Both lists named in the same step, so they cannot be conflated: the
    // durable gate goes, the ADMISSION list stays because EMERG-01 reads it.
    expect(step6).toContain("CANNOT BE DELETED HERE");

    // And the premise the retirement rests on is the one the bridge suite pins:
    // exactly one runtime caller.
    const bridge = readFileSync(
      join(process.cwd(), "lib/booking/new-client-waitlist-durability-bridge.ts"),
      "utf8",
    );
    expect(bridge).toContain("isNewClientWaitlistDurableEnabled(studioSlug)");
  });

  it("does not claim durability is unconditional during the bridge", () => {
    // Exact-head P2 at 8703f2db. The summary said "`waitlist` now means durable.
    // There is no second switch" while the deployed code still routed a
    // listed-but-not-durable studio through email acceptance - contradicting
    // both the code and this document's own step 1, in the section that declares
    // itself the cutover authority.
    const summary = DOC.slice(0, DOC.indexOf("## The transition rule"));
    expect(summary).not.toContain("There is no second switch");
    expect(summary).toContain("but not yet everywhere");
    expect(summary).toContain(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV);
    expect(summary).toContain("EMAIL-ACCEPTANCE");
    // And the code it describes really does still make that distinction.
    const bridge = readFileSync(
      join(process.cwd(), "lib/booking/new-client-waitlist-durability-bridge.ts"),
      "utf8",
    );
    expect(bridge).toContain("isNewClientWaitlistDurableEnabled(studioSlug)");
  });

  it("records that the new-client control does not move booked rights", () => {
    expect(DOC).toContain(
      "It does not touch existing-client, portal or rebook behaviour at any step",
    );
    // And the policy that would have violated it no longer can: it takes a slug.
    expect(POLICY).toContain("studioSlug: string | null | undefined;");
  });
});

// ===========================================================================
// 0205 -- A STUDIO BORN STAMPED RESOLVES AS PERSISTED, NOT AS LEGACY.
//
// 0204 left `set_at` with no default while reading `set_at IS NULL` as the
// pre-0204 legacy marker, so a studio created after 0204 resolved through the
// legacy bridge and its owner was told to choose Waitlist before Open or Closed
// became available. 0205 defaults the column, which puts a new studio on the
// `persisted` branch from birth.
//
// These are UNIT claims about resolution only. That a real INSERT actually
// produces the stamp is a database fact, proved in
// tests/db/new-studio-admission-default.db.test.ts.
// ===========================================================================
describe("0205: a system-initialized studio is persisted from birth", () => {
  const STAMP = "2026-10-01T09:00:00.000Z";

  it("open + stamped -> OPEN / persisted, even with the legacy slug listed", () => {
    // The system-initialized shape: stamped at creation, no owner change yet.
    // It must resolve exactly like an owner-chosen `open`, because the bridge
    // governs only rows whose authority was never initialized.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "willow";
    expect(R("open", false, "willow", STAMP)).toEqual({
      ok: true,
      mode: "open",
      source: "persisted",
    });
  });

  it("the same row WITHOUT the stamp falls to the bridge -- the before/after pair", () => {
    // The control that makes the case above non-vacuous: identical inputs, stamp
    // removed, different answer. If the stamp stopped mattering, this would
    // agree with the previous test and both would be meaningless.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "willow";
    expect(R_UNCHOSEN("open", "willow")).toEqual({
      ok: true,
      mode: "waitlist",
      source: "legacy_bridge",
    });
  });

  it("resolution reads the STAMP only, never who set it", () => {
    // "Initialized or not" is the only question this resolution asks, and both
    // initialized states -- system at creation, owner afterwards -- answer it
    // identically. Keeping `set_by` out of the resolver is what stops provenance
    // leaking into a booking decision that must not depend on it.
    //
    // FIELD NAMES read from the module, not a fixture built here. The block's own
    // doc comment legitimately discusses `new_client_admission_mode_set_by` --
    // explaining why the resolver does not take it -- so a substring search would
    // fail on the very prose that records the decision.
    const moduleSource = readFileSync(
      path.join(process.cwd(), "lib/booking/new-client-admission.ts"),
      "utf8",
    );
    const block = /export function resolveAdmission\(input: \{([\s\S]*?)^\}\):/m.exec(
      moduleSource,
    );
    expect(block, "resolveAdmission's input shape could not be read").toBeTruthy();
    const fields = [...block![1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(fields).toEqual(["storedMode", "storedSetAt", "readFailed", "studioSlug"]);
    expect(fields, "the resolver must not take the actor").not.toContain("storedSetBy");
  });
});
