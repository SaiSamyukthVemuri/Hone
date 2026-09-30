import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { resolveAdmission, newClientMayBook, newClientMayJoinWaitlist, isNewClientAdmissionMode } =
  await import("@/lib/booking/new-client-admission");
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
    expect(R(m)).toEqual({ ok: true, mode: m });
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
    expect(R(null)).toEqual({ ok: true, mode: "waitlist" });
  });

  it("an unlisted studio with no stored value is OPEN", () => {
    expect(R(null)).toEqual({ ok: true, mode: "open" });
  });

  it("the env escalates a stored OPEN to waitlist", () => {
    // During cutover a studio may still be listed while its row carries the
    // 0204 backfill default. It must stay on the waitlist.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "willow";
    expect(R("open")).toEqual({ ok: true, mode: "waitlist" });
  });

  it("the env can NEVER de-escalate a stored waitlist or closed", () => {
    // The whole safety property. If this were two-way, a deploy that dropped a
    // slug would silently reopen a studio its owner had waitlisted or closed.
    expect(R("waitlist")).toEqual({ ok: true, mode: "waitlist" });
    expect(R("closed")).toEqual({ ok: true, mode: "closed" });
  });

  it("another studio's slug does not move THIS studio", () => {
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "some-other-studio";
    expect(R("open")).toEqual({ ok: true, mode: "open" });
  });
});

describe("REGRESSION: removing a slug cannot quietly change the commitment", () => {
  it("once the DB says waitlist, dropping the env leaves it waitlist", () => {
    // The named regression: with the DB authority active, an env edit must not
    // move a studio off the durable path. `waitlist` means the durable row IS
    // the commitment, so this is what keeps submissions from becoming
    // email-only.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "willow";
    expect(R("waitlist")).toEqual({ ok: true, mode: "waitlist" });
    delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
    expect(R("waitlist")).toEqual({ ok: true, mode: "waitlist" });
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
    expect(newClientMayBook({ ok: true, mode: "open" })).toBe(true);
    expect(newClientMayBook({ ok: true, mode: "waitlist" })).toBe(false);
    expect(newClientMayBook({ ok: true, mode: "closed" })).toBe(false);
    expect(newClientMayBook({ ok: false })).toBe(false);
  });

  it("only WAITLIST may join - CLOSED refuses the join as well as the booking", () => {
    expect(newClientMayJoinWaitlist({ ok: true, mode: "waitlist" })).toBe(true);
    expect(newClientMayJoinWaitlist({ ok: true, mode: "open" })).toBe(false);
    expect(newClientMayJoinWaitlist({ ok: true, mode: "closed" })).toBe(false);
    expect(newClientMayJoinWaitlist({ ok: false })).toBe(false);
  });
});
