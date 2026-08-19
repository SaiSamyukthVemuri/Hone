import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEW_CLIENT_WAITLIST_SLUGS_ENV } from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// E / F / G — the waitlist submit action.
// ===========================================================================
//
// The commit law under test:
//
//   studio provider ACCEPTED                       -> success
//   studio provider REJECTED / TIMED OUT / FAILED  -> failure, and NO client
//                                                     confirmation is attempted
//   studio ACCEPTED + client confirmation FAILS    -> still success
//
// Plus the two contracts that make V1 safe to ship without a migration:
//   * ZERO business database writes (the studio lookup is the only DB call).
//   * PII appears in the two emails and nowhere else — not in a log line, not
//     in an error message, not in an analytics payload.

const STUDIO_ID = "22222222-2222-4222-8222-222222222222";
const SLUG = "waitlisted-studio";

// PII canary. These exact strings must never appear outside the email payloads.
const CANARY_NAME = "PII_CANARY_NAME_92837";
const CANARY_EMAIL = "pii_canary_92837@example.com";
const CANARY_PHONE = "+1-555-92837";

type Send = { to: string; subject: string; html: string; text: string };

const sends: Send[] = [];
const rateLimitCalls: unknown[] = [];
const consoleErrors: string[] = [];
const consoleWarns: string[] = [];
const consoleLogs: string[] = [];
/** Every Supabase table/rpc the action touches, whatever the verb. */
const dbOps: string[] = [];

const scenario = {
  studioFound: true as boolean,
  studioLookupThrows: false,
  ownerEmail: "owner@studio.test" as string | null,
  rateLimited: false,
  studioSendOk: true,
  studioSendRetryable: false,
  clientSendOk: true,
  clientSendThrows: false,
};

function reset() {
  sends.length = 0;
  rateLimitCalls.length = 0;
  consoleErrors.length = 0;
  consoleWarns.length = 0;
  consoleLogs.length = 0;
  dbOps.length = 0;
  Object.assign(scenario, {
    studioFound: true,
    studioLookupThrows: false,
    ownerEmail: "owner@studio.test",
    rateLimited: false,
    studioSendOk: true,
    studioSendRetryable: false,
    clientSendOk: true,
    clientSendThrows: false,
  });
}

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@/lib/rate-limit/public", () => ({
  limitWaitlistSubmit: async (args: unknown) => {
    rateLimitCalls.push(args);
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

vi.mock("@/lib/email/send-appointment", () => ({
  sendEmailSafely: async (opts: Send) => {
    sends.push(opts);
    // First send in a run is the STUDIO notification (the action sends it
    // first, by contract); anything after it is the client confirmation.
    const isStudioSend = sends.length === 1;
    if (isStudioSend) {
      return scenario.studioSendOk
        ? { ok: true, messageId: "msg_1" }
        : {
            ok: false,
            // A real provider error can embed the recipient address. Poisoned
            // deliberately so the log sweep below is meaningful.
            error: `provider refused for ${CANARY_EMAIL}`,
            retryable: scenario.studioSendRetryable,
          };
    }
    if (scenario.clientSendThrows) throw new Error(`client send exploded ${CANARY_EMAIL}`);
    return scenario.clientSendOk
      ? { ok: true, messageId: "msg_2" }
      : { ok: false, error: `client provider refused for ${CANARY_EMAIL}`, retryable: true };
  },
}));

// A supabase client would be a business-write surface. The action must never
// construct one; if it does, this mock records it and the no-write test fails.
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    dbOps.push("createAdminClient");
    return {
      from: (t: string) => {
        dbOps.push(`from:${t}`);
        throw new Error("the waitlist action must not touch the database");
      },
      rpc: (fn: string) => {
        dbOps.push(`rpc:${fn}`);
        throw new Error("the waitlist action must not call an RPC");
      },
    };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    dbOps.push("createClient");
    return {
      from: (t: string) => {
        dbOps.push(`from:${t}`);
        throw new Error("the waitlist action must not touch the database");
      },
    };
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
function setEnv(value: string | undefined) {
  if (value === undefined) delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
  else process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = value;
}

let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reset();
  setEnv(SLUG);
  errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    consoleErrors.push(a.map(String).join(" "));
  });
  warnSpy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    consoleWarns.push(a.map(String).join(" "));
  });
  logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    consoleLogs.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  errSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
  setEnv(ORIGINAL);
});

const GENERIC = "We couldn't record your waitlist request. Please try again in a moment.";

describe("submitNewClientBookingWaitlistAction — commit semantics", () => {
  it("studio provider ACCEPTS -> success, studio email first, client confirmation after", async () => {
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: true });
    expect(sends).toHaveLength(2);

    const [studioSend, clientSend] = sends;
    expect(studioSend.to).toBe("owner@studio.test");
    expect(studioSend.subject).toBe("[HONE WAITLIST] New client · Waitlisted Studio");
    expect(studioSend.text).toContain(CANARY_NAME);
    expect(studioSend.text).toContain(CANARY_EMAIL);
    expect(studioSend.text).toContain(CANARY_PHONE);
    expect(studioSend.text).toContain("No appointment has been created.");

    expect(clientSend.to).toBe(CANARY_EMAIL);
    expect(clientSend.subject).toBe("You're on the waitlist · Waitlisted Studio");
    expect(clientSend.text).toContain("no appointment time has been reserved");
  });

  it("studio provider FAILS -> failure, and NO client confirmation is attempted", async () => {
    scenario.studioSendOk = false;
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: false, error: GENERIC });
    expect(sends, "only the studio send may have been attempted").toHaveLength(1);
    expect(sends[0].to).toBe("owner@studio.test");
  });

  it("studio provider TIMES OUT / is unconfigured (retryable failure) -> still a failure", async () => {
    scenario.studioSendOk = false;
    scenario.studioSendRetryable = true;
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result.ok).toBe(false);
    expect(sends).toHaveLength(1);
  });

  it("studio ACCEPTED + client confirmation REJECTED -> overall success", async () => {
    scenario.clientSendOk = false;
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: true });
    expect(sends).toHaveLength(2);
  });

  it("studio ACCEPTED + client confirmation THROWS -> overall success", async () => {
    scenario.clientSendThrows = true;
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: true });
  });

  it("no operational studio recipient -> failure, and nothing is sent", async () => {
    scenario.ownerEmail = null;
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: false, error: GENERIC });
    expect(sends).toEqual([]);
  });

  it("a blank studio recipient is treated as absent", async () => {
    scenario.ownerEmail = "   ";
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result.ok).toBe(false);
    expect(sends).toEqual([]);
  });
});

describe("submitNewClientBookingWaitlistAction — refusals", () => {
  it("flag OFF -> refused BEFORE any email is sent", async () => {
    setEnv(undefined);
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: false, error: GENERIC });
    expect(sends, "the flag-off path must never reach the provider").toEqual([]);
  });

  it("flag ON for a DIFFERENT studio -> refused, nothing sent", async () => {
    setEnv("some-other-studio");
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result.ok).toBe(false);
    expect(sends).toEqual([]);
  });

  it("unknown studio -> generic refusal, nothing sent", async () => {
    scenario.studioFound = false;
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: false, error: GENERIC });
    expect(sends).toEqual([]);
  });

  it("studio lookup THROWS -> generic refusal, no driver text leaks, nothing sent", async () => {
    scenario.studioLookupThrows = true;
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: false, error: GENERIC });
    expect(result.ok === false && result.error).not.toContain("boom");
    expect(sends).toEqual([]);
  });

  it("missing slug -> generic refusal, no studio lookup, nothing sent", async () => {
    const result = await submitNewClientBookingWaitlistAction(form({ slug: "  " }));
    expect(result).toEqual({ ok: false, error: GENERIC });
    expect(dbOps).toEqual([]);
    expect(sends).toEqual([]);
  });

  it("an over-long slug -> generic refusal, and it never reaches the studio query or a log", async () => {
    const huge = "a".repeat(5000);
    const result = await submitNewClientBookingWaitlistAction(form({ slug: huge }));
    expect(result).toEqual({ ok: false, error: GENERIC });
    expect(dbOps, "an unbounded slug must not reach the database").toEqual([]);
    expect(sends).toEqual([]);
    expect([...consoleErrors, ...consoleWarns, ...consoleLogs].join("\n")).not.toContain(huge);
  });

  it("invalid input -> validation refusal BEFORE the rate limiter and the provider", async () => {
    const blankName = await submitNewClientBookingWaitlistAction(form({ name: "   " }));
    expect(blankName).toEqual({ ok: false, error: "Your name is required." });

    const badEmail = await submitNewClientBookingWaitlistAction(form({ email: "nope" }));
    expect(badEmail).toEqual({ ok: false, error: "Enter a valid email address." });

    expect(rateLimitCalls, "validation must run before the limiter").toEqual([]);
    expect(sends).toEqual([]);
    expect(dbOps).toEqual([]);
  });

  it("rate limited -> generic limiter copy and NO email call", async () => {
    scenario.rateLimited = true;
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({
      ok: false,
      error: "Too many requests right now. Please wait a moment and try again.",
    });
    expect(sends, "a rate-limited submission must not reach the provider").toEqual([]);
    expect(dbOps, "a rate-limited submission must not even look up the studio").toEqual([]);
  });

  it("the rate limiter is keyed on the NORMALIZED email", async () => {
    await submitNewClientBookingWaitlistAction(
      form({ email: "  PII_Canary_92837@Example.COM " }),
    );
    expect(rateLimitCalls).toHaveLength(1);
    expect((rateLimitCalls[0] as { email: string }).email).toBe(CANARY_EMAIL);
  });
});

describe("G. zero business database writes", () => {
  it("a SUCCESSFUL submission performs exactly one DB operation: the studio lookup", async () => {
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: true });
    expect(dbOps).toEqual([`select:studios:${SLUG}`]);
  });

  it("never constructs a Supabase client, so it cannot write anything", async () => {
    await submitNewClientBookingWaitlistAction(form());
    expect(dbOps).not.toContain("createAdminClient");
    expect(dbOps).not.toContain("createClient");
  });

  it("does not import the MARKETING waitlist action or the marketing waitlist table", () => {
    // Source contract, not behaviour: `public.waitlist` is the landing-page
    // early-access list (global email uniqueness, no studio ownership). A
    // booking lead must never land there, and the cheapest durable guard
    // against a future "reuse the existing waitlist" edit is this pin.
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "app/book/[slug]/waitlist-actions.ts"),
      "utf8",
    );
    expect(src).not.toContain("submitWaitlistEntry");
    expect(src).not.toContain("@/app/actions/waitlist");
    expect(src).not.toMatch(/from\(\s*["']waitlist["']\s*\)/);
    expect(src).not.toMatch(/\.(insert|upsert|update|delete)\(/);
  });
});

describe("F. PII canary", () => {
  /** Every console channel the action could reach, concatenated. */
  const allLogs = () => [...consoleErrors, ...consoleWarns, ...consoleLogs].join("\n");

  function expectNoCanaryIn(haystack: string, where: string) {
    expect(haystack, `${where} must not carry the raw name`).not.toContain(CANARY_NAME);
    expect(haystack, `${where} must not carry the raw email`).not.toContain(CANARY_EMAIL);
    expect(haystack, `${where} must not carry the raw phone`).not.toContain(CANARY_PHONE);
    expect(haystack, `${where} must not carry the email local part`).not.toContain(
      "pii_canary_92837",
    );
  }

  it("success path logs nothing carrying PII", async () => {
    await submitNewClientBookingWaitlistAction(form());
    expectNoCanaryIn(allLogs(), "the success path log output");
  });

  it("studio-provider-failure path logs nothing carrying PII, and the error copy is generic", async () => {
    scenario.studioSendOk = false;
    const result = await submitNewClientBookingWaitlistAction(form());
    // The provider's own error string embeds the address; it must be dropped.
    expectNoCanaryIn(allLogs(), "the studio-failure log output");
    expect(consoleErrors.join("\n")).toContain("new_client_waitlist_studio_email_failed");
    expectNoCanaryIn(result.ok === false ? result.error : "", "the returned error");
  });

  it("client-confirmation-failure and throw paths log nothing carrying PII", async () => {
    scenario.clientSendOk = false;
    await submitNewClientBookingWaitlistAction(form());
    expectNoCanaryIn(allLogs(), "the client-failure log output");

    reset();
    setEnv(SLUG);
    scenario.clientSendThrows = true;
    await submitNewClientBookingWaitlistAction(form());
    expectNoCanaryIn(allLogs(), "the client-throw log output");
  });

  it("validation and refusal paths log nothing carrying PII", async () => {
    await submitNewClientBookingWaitlistAction(form({ email: `${CANARY_EMAIL} bad` }));
    scenario.ownerEmail = null;
    await submitNewClientBookingWaitlistAction(form());
    scenario.studioLookupThrows = true;
    await submitNewClientBookingWaitlistAction(form());
    expectNoCanaryIn(allLogs(), "the refusal log output");
  });

  it("PII IS carried by the two emails — the canary is proving log hygiene, not absence", async () => {
    await submitNewClientBookingWaitlistAction(form());
    const studio = sends[0];
    expect(studio.text).toContain(CANARY_NAME);
    expect(studio.text).toContain(CANARY_EMAIL);
    expect(studio.text).toContain(CANARY_PHONE);
    expect(studio.html).toContain(CANARY_NAME);
  });
});

describe("HTML / email injection safety", () => {
  it("escapes untrusted public input in the HTML body", async () => {
    await submitNewClientBookingWaitlistAction(
      form({
        name: '<script>alert("xss")</script>',
        email: "a@b.co",
        phone: "<img src=x onerror=alert(1)>",
      }),
    );
    const html = sends[0].html;
    // The payloads survive as INERT TEXT: the tag delimiters are escaped, so
    // no attacker-controlled element or attribute is ever parsed. (Asserting
    // on "onerror=" alone would be wrong — it is harmless once it sits inside
    // an escaped &lt;img&gt; text node.)
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // The client confirmation interpolates the name too.
    expect(sends[1].html).not.toContain("<script>");
    expect(sends[1].html).toContain("&lt;script&gt;");
  });
});
