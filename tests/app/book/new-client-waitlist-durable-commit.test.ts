import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NEW_CLIENT_WAITLIST_SLUGS_ENV,
  NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV,
} from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// WAIT-02 — THE COMMIT POINT MOVED TO THE DATABASE
// ===========================================================================
//
// WAIT-01's operational record was an email, so the provider accepting it was
// the commit. WAIT-02's record is a row, so:
//
//   DATABASE COMMAND SAYS `created`   -> the visitor joined. Full stop.
//   THE EMAIL                         -> notification, reported separately,
//                                        and unable to retract the join.
//
// THE NAMED MUTATION THIS FILE EXISTS TO CATCH: treating the provider as the
// commit point again. "a REFUSED studio notification still reports joined"
// below fails immediately if anyone reintroduces that coupling — and so does
// the call-ORDER assertion, because a provider-first implementation would send
// before the command ran.
//
// The WAIT-01 path is NOT retested here; it keeps its own file
// (new-client-waitlist-action.test.ts), which never sets the durable env var
// and therefore proves the old behaviour is byte-for-byte unchanged.

const STUDIO_ID = "33333333-3333-4333-8333-333333333333";
const SLUG = "durable-waitlist-studio";

const CANARY_NAME = "PII_CANARY_NAME_44551";
const CANARY_EMAIL = "pii_canary_44551@example.com";
const CANARY_PHONE = "+1-555-44551";

type Send = { namespace: string; studioId: string; to: string; subject: string; html: string; text: string };
type RpcCall = { fn: string; args: Record<string, unknown> };
type Outcome =
  | { status: "accepted"; messageId: string }
  | { status: "rejected"; code: string | null }
  | { status: "ambiguous"; reason: string };

const sends: Send[] = [];
const rpcCalls: RpcCall[] = [];
const tableAccess: string[] = [];
const consoleErrors: string[] = [];
// One ordered trace of everything that touched the outside world, so "the
// command ran BEFORE any email" is an assertion rather than an assumption.
const trace: string[] = [];

const scenario = {
  ownerEmail: "owner@studio.test" as string | null,
  rateLimited: false,
  commandResult: "created" as string | null,
  commandError: null as { code: string } | null,
  commandThrows: false,
  adminClientThrows: false,
  studioOutcome: { status: "accepted", messageId: "re_studio_1" } as Outcome,
  clientOutcome: { status: "accepted", messageId: "re_client_1" } as Outcome,
  studioSendThrows: false,
  clientSendThrows: false,
};

function reset() {
  sends.length = 0;
  rpcCalls.length = 0;
  tableAccess.length = 0;
  consoleErrors.length = 0;
  trace.length = 0;
  Object.assign(scenario, {
    ownerEmail: "owner@studio.test",
    rateLimited: false,
    commandResult: "created",
    commandError: null,
    commandThrows: false,
    adminClientThrows: false,
    studioOutcome: { status: "accepted", messageId: "re_studio_1" },
    clientOutcome: { status: "accepted", messageId: "re_client_1" },
    studioSendThrows: false,
    clientSendThrows: false,
  });
}

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@/lib/rate-limit/public", () => ({
  limitNewClientBookingWaitlist: async () =>
    scenario.rateLimited ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true },
  RATE_LIMIT_MESSAGE: "Too many requests right now. Please wait a moment and try again.",
}));

vi.mock("@/lib/booking/queries", () => ({
  getStudioBySlug: async () => ({
    id: STUDIO_ID,
    slug: SLUG,
    name: "Durable Waitlist Studio",
    owner_email: scenario.ownerEmail,
    timezone: "America/Toronto",
  }),
}));

vi.mock("@/lib/email/new-client-waitlist-send", () => ({
  sendWaitlistEmailIdempotent: async (opts: Send) => {
    sends.push(opts);
    trace.push(`send:${opts.namespace}`);
    if (opts.namespace === "studio") {
      if (scenario.studioSendThrows) throw new Error(`studio send exploded ${CANARY_EMAIL}`);
      return scenario.studioOutcome;
    }
    if (scenario.clientSendThrows) throw new Error(`client send exploded ${CANARY_EMAIL}`);
    return scenario.clientOutcome;
  },
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    if (scenario.adminClientThrows) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
    return {
    // Any direct table access from this action would be a business-write
    // surface the release forbids; recording it makes the no-DML test real.
    from: (table: string) => {
      tableAccess.push(table);
      throw new Error(`the waitlist action must not touch tables directly: ${table}`);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      trace.push(`rpc:${fn}`);
      if (scenario.commandThrows) throw new Error(`transport exploded ${CANARY_EMAIL}`);
      if (scenario.commandError) return { data: null, error: scenario.commandError };
      return { data: [{ result: scenario.commandResult, entry_id: "entry-1" }], error: null };
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

const ORIGINAL_GATE = process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
const ORIGINAL_DURABLE = process.env[NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV];
function setEnv(name: string, v: string | undefined) {
  if (v === undefined) delete process.env[name];
  else process.env[name] = v;
}

const FAILED = "We couldn't record your waitlist request. Please try again in a moment.";
const UNCONFIRMED =
  "We couldn't confirm your waitlist request. Please contact the studio before submitting again.";

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reset();
  setEnv(NEW_CLIENT_WAITLIST_SLUGS_ENV, SLUG);
  setEnv(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, SLUG);
  errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    consoleErrors.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  errSpy.mockRestore();
  setEnv(NEW_CLIENT_WAITLIST_SLUGS_ENV, ORIGINAL_GATE);
  setEnv(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, ORIGINAL_DURABLE);
});

describe("the database is the commit point", () => {
  it("`created` -> joined, and the command ran BEFORE any email", async () => {
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: true, state: "joined", notification: "sent" });
    expect(trace).toEqual(["rpc:join_new_client_waitlist", "send:studio", "send:client"]);
  });

  it("A REFUSED STUDIO NOTIFICATION STILL REPORTS JOINED", async () => {
    // The whole point of WAIT-02. Under WAIT-01 this exact scenario returned
    // ok:false — a truthful answer then, and a false one now that the record
    // is a committed row.
    scenario.studioOutcome = { status: "rejected", code: "validation_error" };
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: true, state: "joined", notification: "unconfirmed" });
    expect(rpcCalls).toHaveLength(1);
  });

  it("an AMBIGUOUS studio notification still reports joined", async () => {
    scenario.studioOutcome = { status: "ambiguous", reason: "timeout" };
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({
      ok: true,
      state: "joined",
      notification: "unconfirmed",
    });
  });

  it("a THROWING studio notification still reports joined", async () => {
    // A provider throw AFTER the commit must not become the visitor's answer,
    // and must not abort the courtesy acknowledgement either.
    scenario.studioSendThrows = true;
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({
      ok: true,
      state: "joined",
      notification: "unconfirmed",
    });
    expect(sends.map((s) => s.namespace)).toEqual(["studio", "client"]);
  });

  it("a THROWING client acknowledgement cannot downgrade the join either", async () => {
    scenario.clientSendThrows = true;
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({
      ok: true,
      state: "joined",
      notification: "sent",
    });
  });

  it("NO studio recipient configured still reports joined, and sends nothing to the studio", async () => {
    // Under WAIT-01 this was fatal: with no destination the request vanished.
    // The row exists regardless, and the operator queue reads the row.
    scenario.ownerEmail = null;
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: true, state: "joined", notification: "unconfirmed" });
    expect(sends.map((s) => s.namespace)).toEqual(["client"]);
  });

  it("passes the SERVER-RESOLVED studio id and the bounded submission, nothing else", async () => {
    await submitNewClientBookingWaitlistAction(form({ slug: "attacker-chosen-slug" }));
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("join_new_client_waitlist");
    expect(rpcCalls[0].args).toEqual({
      p_studio_id: STUDIO_ID,
      p_name: CANARY_NAME,
      p_email: CANARY_EMAIL,
      p_phone: CANARY_PHONE,
    });
    // No status, no source, no joined_at, no entry id: the command owns all of
    // them, so a forged post cannot propose one.
    for (const forbidden of ["p_status", "p_source", "p_joined_at", "p_entry_id", "p_id"]) {
      expect(Object.keys(rpcCalls[0].args)).not.toContain(forbidden);
    }
  });

  it("performs NO direct table access at all", async () => {
    await submitNewClientBookingWaitlistAction(form());
    expect(tableAccess).toEqual([]);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["join_new_client_waitlist"]);
  });
});

describe("duplicate submission", () => {
  it("is calm, idempotent, and sends NOTHING", async () => {
    scenario.commandResult = "already_waiting";
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: true, state: "already_waiting" });
    expect(sends).toHaveLength(0);
  });

  it("is not an error, so it does not invite a third submission", async () => {
    scenario.commandResult = "already_waiting";
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/try again|error/i);
  });
});

describe("refusals leave nothing committed and say so", () => {
  it.each(["invalid_input", "studio_not_found", "unknown", "some_future_code", null])(
    "`%s` -> the generic failure message, with no email sent",
    async (code) => {
      scenario.commandResult = code;
      const result = await submitNewClientBookingWaitlistAction(form());
      expect(result).toEqual({ ok: false, error: FAILED });
      expect(sends).toHaveLength(0);
    },
  );

  it("every refusal reads IDENTICALLY, so the command's codes cannot be probed", async () => {
    const messages = new Set<string>();
    for (const code of ["invalid_input", "studio_not_found", "unknown"]) {
      reset();
      scenario.commandResult = code;
      const result = await submitNewClientBookingWaitlistAction(form());
      if (!result.ok) messages.add(result.error);
    }
    expect(messages.size).toBe(1);
  });
});

describe("transport failures are classified honestly", () => {
  it("a MISSING command (42883) is a definite failure: nothing committed", async () => {
    // The NEW-app/OLD-database skew — the durable flag switched on before
    // migration 0185 was applied. "Contact the studio" would be wrong: there
    // is nothing to contact them about.
    scenario.commandError = { code: "42883" };
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({
      ok: false,
      error: FAILED,
    });
    expect(sends).toHaveLength(0);
  });

  it("a missing PostgREST route (PGRST202) is treated the same way", async () => {
    scenario.commandError = { code: "PGRST202" };
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({
      ok: false,
      error: FAILED,
    });
  });

  it("any OTHER database error is AMBIGUOUS: it may have committed", async () => {
    scenario.commandError = { code: "57014" }; // query_canceled
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({
      ok: false,
      error: UNCONFIRMED,
    });
    expect(sends).toHaveLength(0);
  });

  it("a MISSING service-role key is a definite failure, not an ambiguous one", async () => {
    // Nothing reached the database, so "try again" is true and pointing the
    // visitor at a human about a request that may have landed would not be.
    scenario.adminClientThrows = true;
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({
      ok: false,
      error: FAILED,
    });
    expect(rpcCalls).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it("a THROW at transport level is ambiguous, never a claimed join", async () => {
    scenario.commandThrows = true;
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({
      ok: false,
      error: UNCONFIRMED,
    });
  });
});

describe("the gate still governs everything", () => {
  it("a studio NOT in the waitlist gate never reaches the command", async () => {
    setEnv(NEW_CLIENT_WAITLIST_SLUGS_ENV, "some-other-studio");
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({
      ok: false,
      error: FAILED,
    });
    expect(rpcCalls).toHaveLength(0);
  });

  it("a rate-limited submission never reaches the command", async () => {
    scenario.rateLimited = true;
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result.ok).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });

  it("invalid input never reaches the command", async () => {
    const result = await submitNewClientBookingWaitlistAction(form({ email: "nope" }));
    expect(result).toEqual({ ok: false, error: "Enter a valid email address." });
    expect(rpcCalls).toHaveLength(0);
  });

  it("with the DURABLE flag unset, no database command runs at all", async () => {
    // Stage A of the rollout: migration applied, code deployed, dark.
    setEnv(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, undefined);
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(rpcCalls).toHaveLength(0);
    expect(result).toEqual({ ok: true, state: "joined", notification: "sent" });
  });

  it("the durable flag is EXACT-MATCH, not a prefix or substring", async () => {
    setEnv(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, `${SLUG}-archive,other-studio`);
    await submitNewClientBookingWaitlistAction(form());
    expect(rpcCalls).toHaveLength(0);
  });

  it("the durable flag is derived from the SERVER-RESOLVED slug, not the posted one", async () => {
    // The form claims a slug that IS listed; the resolved studio's slug is not.
    setEnv(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, "attacker-chosen-slug");
    await submitNewClientBookingWaitlistAction(form({ slug: "attacker-chosen-slug" }));
    expect(rpcCalls).toHaveLength(0);
  });

  it("a blank or whitespace-only durable list is OFF", async () => {
    for (const value of ["", "   ", ",, ,"]) {
      reset();
      setEnv(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, value);
      await submitNewClientBookingWaitlistAction(form());
      expect(rpcCalls, `value ${JSON.stringify(value)} must be OFF`).toHaveLength(0);
    }
  });
});

describe("PII never leaves the emails and the row", () => {
  it("no log line carries the name, email or phone — on any outcome", async () => {
    const outcomes: Array<() => void> = [
      () => { scenario.commandResult = "already_waiting"; },
      () => { scenario.commandResult = "invalid_input"; },
      () => { scenario.commandThrows = true; },
      () => { scenario.adminClientThrows = true; },
      () => { scenario.commandError = { code: "57014" }; },
      () => { scenario.studioOutcome = { status: "rejected", code: "validation_error" }; },
      () => { scenario.studioOutcome = { status: "ambiguous", reason: "timeout" }; },
      () => { scenario.ownerEmail = null; },
      () => { scenario.studioSendThrows = true; },
      () => { scenario.clientSendThrows = true; },
    ];
    for (const apply of outcomes) {
      reset();
      apply();
      await submitNewClientBookingWaitlistAction(form());
      const logs = consoleErrors.join("\n");
      expect(logs).not.toContain(CANARY_NAME);
      expect(logs).not.toContain(CANARY_EMAIL);
      expect(logs).not.toContain(CANARY_PHONE);
    }
  });

  it("logs the studio id and a non-identifying classification instead", async () => {
    scenario.commandResult = "invalid_input";
    await submitNewClientBookingWaitlistAction(form());
    const line = consoleErrors.find((l) => l.includes("new_client_waitlist_command_refused"));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.studioId).toBe(STUDIO_ID);
    expect(parsed.result).toBe("invalid_input");
  });

  it("a provider error NAME is logged, never its message", async () => {
    scenario.studioOutcome = { status: "rejected", code: "validation_error" };
    await submitNewClientBookingWaitlistAction(form());
    const line = consoleErrors.find((l) =>
      l.includes("new_client_waitlist_studio_email_not_accepted"),
    );
    expect(line).toBeDefined();
    expect(JSON.parse(line!).detail).toBe("validation_error");
  });
});
