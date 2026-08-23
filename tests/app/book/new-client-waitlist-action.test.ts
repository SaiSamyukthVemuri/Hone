import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEW_CLIENT_WAITLIST_SLUGS_ENV } from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// THE WAITLIST SUBMIT ACTION
// ===========================================================================
//
// Commit law under test:
//   provider ACCEPTED with a message id            -> success
//   provider REFUSED                               -> failure (known not sent)
//   provider AMBIGUOUS after one idempotent retry  -> UNCONFIRMED, distinct copy
//   studio committed + client confirmation fails   -> still success
//
// Plus the contracts that make a no-migration V1 safe: zero business DB
// writes, `public.waitlist` untouched, PII confined to the two emails, and the
// studio-scoped limiter consulted with the SERVER-RESOLVED studio id.
//
// WAIT-02 NOTE. This file is now the regression proof for the studio that has
// NOT been moved to the durable record. `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS`
// is never set here, so every case below runs the notification-commit path
// exactly as production does today — including its fail-closed semantics and
// its refusal to touch a database at all (the mocked admin client throws on any
// `from`/`rpc`, so a stray write would fail these tests, not pass them). The
// durable path has its own file: new-client-waitlist-durable-commit.test.ts.
//
// The success SHAPE is `{ ok: true }` and nothing more. It briefly carried
// `state` and `notification` so the browser could tell "joined" from "already
// waiting"; that was removed because on a public, unauthenticated endpoint it
// let anyone learn whether a named address was already on a studio's waitlist.
// Nothing about WHEN this path succeeds changed, then or now.

const STUDIO_ID = "22222222-2222-4222-8222-222222222222";
const SLUG = "waitlisted-studio";

const CANARY_NAME = "PII_CANARY_NAME_92837";
const CANARY_EMAIL = "pii_canary_92837@example.com";
const CANARY_PHONE = "+1-555-92837";

type Send = {
  namespace: string;
  studioId: string;
  eventScope?: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
};

const sends: Send[] = [];
const limiterCalls: Array<{ studioId: string; email: string }> = [];
const consoleErrors: string[] = [];
const consoleWarns: string[] = [];
const consoleLogs: string[] = [];
const dbOps: string[] = [];

type Outcome =
  | { status: "accepted"; messageId: string }
  | { status: "rejected"; code: string | null }
  | { status: "ambiguous"; reason: string };

const scenario = {
  studioFound: true,
  studioLookupThrows: false,
  ownerEmail: "owner@studio.test" as string | null,
  rateLimited: false,
  studioOutcome: { status: "accepted", messageId: "re_studio_1" } as Outcome,
  clientOutcome: { status: "accepted", messageId: "re_client_1" } as Outcome,
  clientSendThrows: false,
};

function reset() {
  sends.length = 0;
  limiterCalls.length = 0;
  consoleErrors.length = 0;
  consoleWarns.length = 0;
  consoleLogs.length = 0;
  dbOps.length = 0;
  Object.assign(scenario, {
    studioFound: true,
    studioLookupThrows: false,
    ownerEmail: "owner@studio.test",
    rateLimited: false,
    studioOutcome: { status: "accepted", messageId: "re_studio_1" },
    clientOutcome: { status: "accepted", messageId: "re_client_1" },
    clientSendThrows: false,
  });
}

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@/lib/rate-limit/public", () => ({
  limitNewClientBookingWaitlist: async (args: { studioId: string; email: string }) => {
    limiterCalls.push({ studioId: args.studioId, email: args.email });
    return scenario.rateLimited
      ? { allowed: false, retryAfterSeconds: 60 }
      : { allowed: true };
  },
  RATE_LIMIT_MESSAGE: "Too many requests right now. Please wait a moment and try again.",
}));

vi.mock("@/lib/booking/queries", () => ({
  getStudioBySlug: async (slug: string) => {
    dbOps.push(`select:studios:${slug}`);
    if (scenario.studioLookupThrows) throw new Error("Failed to load studio: boom");
    if (!scenario.studioFound) return null;
    return {
      id: STUDIO_ID,
      slug: SLUG,
      name: "Waitlisted Studio",
      owner_email: scenario.ownerEmail,
      timezone: "America/Toronto",
    };
  },
}));

vi.mock("@/lib/email/new-client-waitlist-send", () => ({
  sendWaitlistEmailIdempotent: async (opts: Send) => {
    sends.push(opts);
    const isStudioSend = sends.length === 1;
    if (isStudioSend) return scenario.studioOutcome;
    if (scenario.clientSendThrows) throw new Error(`client send exploded ${CANARY_EMAIL}`);
    return scenario.clientOutcome;
  },
}));

// A Supabase client would be a business-write surface. The action must never
// construct one; if it does, these record it and the no-write tests fail.
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    dbOps.push("createAdminClient");
    return {
      from: (t: string) => { dbOps.push(`from:${t}`); throw new Error("no DB from the waitlist action"); },
      rpc: (fn: string) => { dbOps.push(`rpc:${fn}`); throw new Error("no RPC from the waitlist action"); },
    };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    dbOps.push("createClient");
    return { from: (t: string) => { dbOps.push(`from:${t}`); throw new Error("no DB"); } };
  },
}));

const { submitNewClientBookingWaitlistAction } = await import(
  "@/app/book/[slug]/waitlist-actions"
);

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("slug", SLUG);
  fd.set("name", CANARY_NAME);
  fd.set("email", CANARY_EMAIL);
  fd.set("phone", CANARY_PHONE);
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

const ORIGINAL = process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
function setEnv(v: string | undefined) {
  if (v === undefined) delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
  else process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = v;
}

let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reset();
  setEnv(SLUG);
  errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { consoleErrors.push(a.map(String).join(" ")); });
  warnSpy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { consoleWarns.push(a.map(String).join(" ")); });
  logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { consoleLogs.push(a.map(String).join(" ")); });
});
afterEach(() => {
  errSpy.mockRestore(); warnSpy.mockRestore(); logSpy.mockRestore();
  setEnv(ORIGINAL);
});

const FAILED = "We couldn't record your waitlist request. Please try again in a moment.";
const UNCONFIRMED =
  "We couldn't confirm your waitlist request. Please contact the studio before submitting again.";
const allLogs = () => [...consoleErrors, ...consoleWarns, ...consoleLogs].join("\n");

describe("commit semantics", () => {
  it("provider ACCEPTS with a message id -> success; studio first, client second", async () => {
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: true });
    expect(sends).toHaveLength(2);

    const [studioSend, clientSend] = sends;
    expect(studioSend.to).toBe("owner@studio.test");
    expect(studioSend.subject).toBe("[HONE WAITLIST] New client · Waitlisted Studio");
    expect(studioSend.text).toContain(CANARY_NAME);
    expect(studioSend.text).toContain("No appointment has been created.");
    expect(clientSend.to).toBe(CANARY_EMAIL);
    expect(clientSend.subject).toBe("You're on the waitlist · Waitlisted Studio");
  });

  it("each email is sent under its OWN key namespace", async () => {
    await submitNewClientBookingWaitlistAction(form());
    expect(sends[0].namespace).toBe("studio");
    expect(sends[1].namespace).toBe("client");
  });

  it("BOTH sends carry the SERVER-RESOLVED studio id as tenant scope", async () => {
    await submitNewClientBookingWaitlistAction(form());
    expect(sends[0].studioId).toBe(STUDIO_ID);
    expect(sends[1].studioId).toBe(STUDIO_ID);
  });

  it("NEITHER send carries an event scope — this path's keys are unchanged", async () => {
    // WAIT-02 added an optional third key component for callers that have a
    // durable event identity. This path has none: the email IS the record, and
    // an identical resubmission must still COLLAPSE at the provider rather than
    // send twice. Passing a scope here would silently change every key.
    await submitNewClientBookingWaitlistAction(form());
    expect(sends[0].eventScope ?? null).toBeNull();
    expect(sends[1].eventScope ?? null).toBeNull();
  });

  it("a FORGED slug cannot alter the tenant component used downstream", async () => {
    // The browser-supplied slug is only ever a lookup pointer. Whatever it
    // says, the tenant scope handed to the limiter and the key derivation is
    // the id read off the resolved studios row — never the slug string itself.
    await submitNewClientBookingWaitlistAction(form({ slug: "attacker-chosen-slug" }));
    expect(sends[0].studioId).toBe(STUDIO_ID);
    expect(sends[0].studioId).not.toBe("attacker-chosen-slug");
    expect(limiterCalls[0].studioId).toBe(STUDIO_ID);
    expect(limiterCalls[0].studioId).not.toBe("attacker-chosen-slug");
    // And the tenant scope is a uuid, not any slug-shaped string.
    expect(sends[0].studioId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("resubmitting the SAME details renders BYTE-IDENTICAL payloads, whatever the clock says", async () => {
    // This is the property that makes the provider collapse a duplicate rather
    // than reject it: the key is derived from these bytes, so if they drifted
    // with the wall clock an honest resubmission would fail for 24 hours.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00Z"));
    await submitNewClientBookingWaitlistAction(form());
    const first = { ...sends[0] };
    reset(); setEnv(SLUG);
    vi.setSystemTime(new Date("2026-08-19T10:47:31Z"));
    await submitNewClientBookingWaitlistAction(form());
    vi.useRealTimers();
    expect(sends[0]).toEqual(first);
  });

  it("the studio notice carries no wall clock at all", async () => {
    await submitNewClientBookingWaitlistAction(form());
    expect(sends[0].text).not.toMatch(/Joined:/i);
    expect(sends[0].html).not.toMatch(/Joined:/i);
    expect(sends[0].text).not.toMatch(/20\d\d/);
  });

  it("a materially DIFFERENT submission renders a different payload", async () => {
    await submitNewClientBookingWaitlistAction(form());
    const first = { ...sends[0] };
    reset(); setEnv(SLUG);
    await submitNewClientBookingWaitlistAction(form({ email: "someone.else@example.com" }));
    expect(sends[0]).not.toEqual(first);
  });

  it("provider REFUSES -> failure, and NO client confirmation is attempted", async () => {
    scenario.studioOutcome = { status: "rejected", code: "validation_error" };
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: false, error: FAILED });
    expect(sends, "the client must not be told they joined").toHaveLength(1);
    expect(consoleErrors.join("\n")).toContain("new_client_waitlist_studio_email_rejected");
  });

  it("AMBIGUOUS (timeout) -> distinct unconfirmed copy, no client confirmation, never 'you joined'", async () => {
    scenario.studioOutcome = { status: "ambiguous", reason: "timeout" };
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: false, error: UNCONFIRMED });
    expect(sends).toHaveLength(1);
    // The copy must NOT invite a blind retry, because the first request may
    // still be processing.
    expect(result.ok === false && result.error).toContain("contact the studio");
    expect(result.ok === false && result.error).not.toBe(FAILED);
    expect(consoleErrors.join("\n")).toContain("new_client_waitlist_studio_email_unconfirmed");
  });

  it("AMBIGUOUS (concurrent) is unconfirmed too, and is distinguishable in the logs", async () => {
    scenario.studioOutcome = { status: "ambiguous", reason: "concurrent" };
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: false, error: UNCONFIRMED });
    expect(consoleErrors.join("\n")).toContain("concurrent");
  });

  it("AMBIGUOUS (no message id) -> unconfirmed, never success", async () => {
    scenario.studioOutcome = { status: "ambiguous", reason: "no_message_id" };
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: false, error: UNCONFIRMED });
    expect(sends).toHaveLength(1);
  });

  it("studio committed + client confirmation NOT accepted -> overall success", async () => {
    scenario.clientOutcome = { status: "rejected", code: "validation_error" };
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({ ok: true });
    expect(sends).toHaveLength(2);
  });

  it("studio committed + client confirmation THROWS -> overall success", async () => {
    scenario.clientSendThrows = true;
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({ ok: true });
  });

  it("no operational studio recipient -> failure, nothing sent", async () => {
    for (const owner of [null, "   "]) {
      reset(); setEnv(SLUG);
      scenario.ownerEmail = owner;
      const result = await submitNewClientBookingWaitlistAction(form());
      expect(result).toEqual({ ok: false, error: FAILED });
      expect(sends).toEqual([]);
    }
  });
});

describe("refusals and ordering", () => {
  it("flag OFF -> refused before any send AND before the limiter", async () => {
    setEnv(undefined);
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: false, error: FAILED });
    expect(sends).toEqual([]);
    expect(limiterCalls, "a non-waitlisted studio must consume no quota").toEqual([]);
  });

  it("flag ON for a DIFFERENT studio -> refused, nothing sent", async () => {
    setEnv("some-other-studio");
    expect((await submitNewClientBookingWaitlistAction(form())).ok).toBe(false);
    expect(sends).toEqual([]);
  });

  it("unknown studio -> generic refusal, nothing sent", async () => {
    scenario.studioFound = false;
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({ ok: false, error: FAILED });
    expect(sends).toEqual([]);
  });

  it("studio lookup THROWS -> generic refusal, no driver text leaks", async () => {
    scenario.studioLookupThrows = true;
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: false, error: FAILED });
    expect(result.ok === false && result.error).not.toContain("boom");
    expect(sends).toEqual([]);
  });

  it("missing or over-long slug -> generic refusal, no studio query, nothing logged raw", async () => {
    expect(await submitNewClientBookingWaitlistAction(form({ slug: "  " }))).toEqual({ ok: false, error: FAILED });
    expect(dbOps).toEqual([]);
    reset(); setEnv(SLUG);
    const huge = "a".repeat(5000);
    expect(await submitNewClientBookingWaitlistAction(form({ slug: huge }))).toEqual({ ok: false, error: FAILED });
    expect(dbOps, "an unbounded slug must not reach the database").toEqual([]);
    expect(allLogs()).not.toContain(huge);
  });

  it("invalid input -> validation refusal BEFORE the limiter and the provider", async () => {
    expect(await submitNewClientBookingWaitlistAction(form({ name: "   " })))
      .toEqual({ ok: false, error: "Your name is required." });
    expect(await submitNewClientBookingWaitlistAction(form({ email: "nope" })))
      .toEqual({ ok: false, error: "Enter a valid email address." });
    expect(limiterCalls).toEqual([]);
    expect(sends).toEqual([]);
    expect(dbOps).toEqual([]);
  });

  it("rate limited -> generic limiter copy and NO send", async () => {
    scenario.rateLimited = true;
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({
      ok: false,
      error: "Too many requests right now. Please wait a moment and try again.",
    });
    expect(sends).toEqual([]);
  });

  it("the limiter receives the SERVER-RESOLVED studio id and the normalized email", async () => {
    await submitNewClientBookingWaitlistAction(form({ email: "  PII_Canary_92837@Example.COM " }));
    expect(limiterCalls).toEqual([{ studioId: STUDIO_ID, email: CANARY_EMAIL }]);
  });
});

describe("zero business database writes", () => {
  it("a SUCCESSFUL submission performs exactly one DB operation: the studio lookup", async () => {
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({ ok: true });
    expect(dbOps).toEqual([`select:studios:${SLUG}`]);
  });

  it("never constructs a Supabase client, so it cannot write anything", async () => {
    await submitNewClientBookingWaitlistAction(form());
    expect(dbOps).not.toContain("createAdminClient");
    expect(dbOps).not.toContain("createClient");
  });

  it("does not import the MARKETING waitlist action, its table, or its limiter", () => {
    // `public.waitlist` is the landing-page early-access list (global email
    // uniqueness, no studio ownership). A booking lead must never land there,
    // and this pin is the cheapest durable guard against a future "just reuse
    // the existing waitlist" edit.
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "app/book/[slug]/waitlist-actions.ts"),
      "utf8",
    );
    expect(src).not.toContain("submitWaitlistEntry");
    expect(src).not.toContain("@/app/actions/waitlist");
    expect(src).not.toMatch(/from\(\s*["']waitlist["']\s*\)/);
    expect(src).not.toMatch(/\.(insert|upsert|update|delete)\(/);
    // The predecessor's defect: the shared marketing limiter.
    expect(src).not.toContain("limitWaitlistSubmit");
  });
});

describe("PII canary", () => {
  function expectNoCanaryIn(haystack: string, where: string) {
    expect(haystack, `${where}: raw name`).not.toContain(CANARY_NAME);
    expect(haystack, `${where}: raw email`).not.toContain(CANARY_EMAIL);
    expect(haystack, `${where}: raw phone`).not.toContain(CANARY_PHONE);
    expect(haystack, `${where}: email local part`).not.toContain("pii_canary_92837");
  }

  it("no console channel carries PII on ANY outcome", async () => {
    const outcomes: Outcome[] = [
      { status: "accepted", messageId: "re_x" },
      { status: "rejected", code: "validation_error" },
      { status: "ambiguous", reason: "timeout" },
      { status: "ambiguous", reason: "concurrent" },
      { status: "ambiguous", reason: "no_message_id" },
    ];
    for (const outcome of outcomes) {
      reset(); setEnv(SLUG);
      scenario.studioOutcome = outcome;
      const result = await submitNewClientBookingWaitlistAction(form());
      expectNoCanaryIn(allLogs(), `studio outcome ${outcome.status}`);
      expectNoCanaryIn(result.ok === false ? result.error : "", "returned error");
    }
  });

  it("no idempotency key or canonical payload material is logged", async () => {
    await submitNewClientBookingWaitlistAction(form());
    const logs = allLogs();
    expect(logs).not.toContain("hone-waitlist-studio-v1");
    expect(logs).not.toContain("hone-waitlist-client-v1");
    expect(logs).not.toContain(sends[0].subject);
    expect(logs).not.toContain(sends[0].html);
  });

  it("client-failure, client-throw and refusal paths stay clean", async () => {
    scenario.clientOutcome = { status: "rejected", code: "x" };
    await submitNewClientBookingWaitlistAction(form());
    expectNoCanaryIn(allLogs(), "client failure");

    reset(); setEnv(SLUG); scenario.clientSendThrows = true;
    await submitNewClientBookingWaitlistAction(form());
    expectNoCanaryIn(allLogs(), "client throw");

    reset(); setEnv(SLUG); scenario.ownerEmail = null;
    await submitNewClientBookingWaitlistAction(form());
    expectNoCanaryIn(allLogs(), "no recipient");
  });

  it("PII IS carried by the two emails — the canary proves log hygiene, not absence", async () => {
    await submitNewClientBookingWaitlistAction(form());
    expect(sends[0].text).toContain(CANARY_NAME);
    expect(sends[0].text).toContain(CANARY_EMAIL);
    expect(sends[0].text).toContain(CANARY_PHONE);
  });
});

describe("HTML / email injection safety", () => {
  it("escapes untrusted public input into inert text", async () => {
    await submitNewClientBookingWaitlistAction(
      form({
        name: '<script>alert("xss")</script>',
        email: "a@b.co",
        phone: "<img src=x onerror=alert(1)>",
      }),
    );
    const html = sends[0].html;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(sends[1].html).not.toContain("<script>");
    expect(sends[1].html).toContain("&lt;script&gt;");
  });
});
