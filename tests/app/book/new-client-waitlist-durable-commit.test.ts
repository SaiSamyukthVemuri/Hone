import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
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

type Send = {
  namespace: string;
  studioId: string;
  eventScope?: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
};
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
  entryId: "entry-1" as string | null,
  commandError: null as { code: string } | null,
  commandThrows: false,
  adminClientThrows: false,
  studioOutcome: { status: "accepted", messageId: "re_studio_1" } as Outcome,
  clientOutcome: { status: "accepted", messageId: "re_client_1" } as Outcome,
  studioSendThrows: false,
  studioSendHangs: false,
  clientSendThrows: false,
};

function reset() {
  deferred.length = 0;
  sends.length = 0;
  rpcCalls.length = 0;
  tableAccess.length = 0;
  consoleErrors.length = 0;
  trace.length = 0;
  Object.assign(scenario, {
    ownerEmail: "owner@studio.test",
    rateLimited: false,
    commandResult: "created",
    entryId: "entry-1",
    commandError: null,
    commandThrows: false,
    adminClientThrows: false,
    studioOutcome: { status: "accepted", messageId: "re_studio_1" },
    clientOutcome: { status: "accepted", messageId: "re_client_1" },
    studioSendThrows: false,
    studioSendHangs: false,
    clientSendThrows: false,
  });
}

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

// Post-response work is CAPTURED, not run. That is what makes "the action
// returned before any provider call" an assertion rather than a hope: nothing
// in `deferred` has executed until a test drains it.
const deferred: Array<() => Promise<void>> = [];
vi.mock("next/server", () => ({
  after: (work: () => Promise<void>) => {
    deferred.push(work);
  },
}));

/** Run everything the action scheduled for after the response. */
async function flushPostResponse(): Promise<void> {
  const queued = deferred.splice(0, deferred.length);
  for (const work of queued) await work();
}

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
      if (scenario.studioSendHangs) return new Promise(() => {});
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
      return {
        data: [{ result: scenario.commandResult, entry_id: scenario.entryId }],
        error: null,
      };
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
    expect(result).toEqual({ ok: true });
    // Nothing has been sent yet: the sends are post-response work.
    expect(trace).toEqual(["rpc:join_new_client_waitlist"]);
    await flushPostResponse();
    expect(trace).toEqual(["rpc:join_new_client_waitlist", "send:studio", "send:client"]);
  });

  it("A REFUSED STUDIO NOTIFICATION STILL REPORTS JOINED", async () => {
    // The whole point of WAIT-02. Under WAIT-01 this exact scenario returned
    // ok:false — a truthful answer then, and a false one now that the record
    // is a committed row.
    scenario.studioOutcome = { status: "rejected", code: "validation_error" };
    const result = await submitNewClientBookingWaitlistAction(form());
    await flushPostResponse();
    expect(result).toEqual({ ok: true });
    expect(rpcCalls).toHaveLength(1);
  });

  it("an AMBIGUOUS studio notification still reports joined", async () => {
    scenario.studioOutcome = { status: "ambiguous", reason: "timeout" };
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({ ok: true });
  });

  it("a THROWING studio notification still reports joined", async () => {
    // A provider throw AFTER the commit must not become the visitor's answer,
    // and must not abort the courtesy acknowledgement either.
    scenario.studioSendThrows = true;
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({ ok: true });
    await flushPostResponse();
    expect(sends.map((s) => s.namespace)).toEqual(["studio", "client"]);
  });

  it("a THROWING client acknowledgement cannot downgrade the join either", async () => {
    scenario.clientSendThrows = true;
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({ ok: true });
  });

  it("NO studio recipient configured still reports joined, and sends nothing to the studio", async () => {
    // Under WAIT-01 this was fatal: with no destination the request vanished.
    // The row exists regardless, and the operator queue reads the row.
    scenario.ownerEmail = null;
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result).toEqual({ ok: true });
    await flushPostResponse();
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
    expect(result).toEqual({ ok: true });
    expect(sends).toHaveLength(0);
  });

  it("is not an error, so it does not invite a third submission", async () => {
    scenario.commandResult = "already_waiting";
    const result = await submitNewClientBookingWaitlistAction(form());
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/try again|error/i);
  });

  it("still creates NO second row and NO second notification", async () => {
    // The internal distinction is preserved even though the caller cannot see
    // it: a duplicate must not manufacture a row or a message.
    scenario.commandResult = "already_waiting";
    await submitNewClientBookingWaitlistAction(form());
    expect(rpcCalls.map((c) => c.fn)).toEqual(["join_new_client_waitlist"]);
    expect(sends).toHaveLength(0);
    expect(tableAccess).toEqual([]);
  });

  it("is still visible to the OPERATOR, in a PII-free log line", async () => {
    scenario.commandResult = "already_waiting";
    await submitNewClientBookingWaitlistAction(form());
    const line = consoleErrors.find((l) =>
      l.includes("new_client_waitlist_duplicate_submission"),
    );
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.studioId).toBe(STUDIO_ID);
    expect(line).not.toContain(CANARY_NAME);
    expect(line).not.toContain(CANARY_EMAIL);
    expect(line).not.toContain(CANARY_PHONE);
  });
});

// ===========================================================================
// NO PUBLIC MEMBERSHIP ORACLE
// ===========================================================================
//
// This action is public and unauthenticated. If a fresh join and an
// already-waiting duplicate answer differently, then typing someone's address
// into the form once tells an anonymous caller whether that named person has
// asked this studio for treatment. The limiters bound volume; they do not stop
// one targeted probe.
//
// So the two outcomes must be externally IDENTICAL. Both are driven through
// the REAL action here, and the results compared as bytes rather than shapes.
describe("a duplicate is externally indistinguishable from a fresh join", () => {
  async function resultFor(commandResult: string) {
    reset();
    setEnv(NEW_CLIENT_WAITLIST_SLUGS_ENV, SLUG);
    setEnv(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, SLUG);
    scenario.commandResult = commandResult;
    return submitNewClientBookingWaitlistAction(form());
  }

  it("returns a BYTE-IDENTICAL value for `created` and `already_waiting`", async () => {
    const created = await resultFor("created");
    const duplicate = await resultFor("already_waiting");
    expect(duplicate).toEqual(created);
    expect(JSON.stringify(duplicate)).toBe(JSON.stringify(created));
    expect(Object.keys(duplicate as object)).toEqual(["ok"]);
  });

  it("stays identical even when the studio notification is NOT accepted", async () => {
    // The old caveat field leaked the same bit in reverse: only a fresh join
    // could ever carry it, so seeing it proved the address was NOT already
    // waiting. A provider failure must therefore change nothing visible.
    reset();
    setEnv(NEW_CLIENT_WAITLIST_SLUGS_ENV, SLUG);
    setEnv(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, SLUG);
    scenario.commandResult = "created";
    scenario.studioOutcome = { status: "rejected", code: "validation_error" };
    const failedNotice = await submitNewClientBookingWaitlistAction(form());

    const duplicate = await resultFor("already_waiting");
    expect(JSON.stringify(failedNotice)).toBe(JSON.stringify(duplicate));
  });

  it("carries no field, code or wording that could name either outcome", async () => {
    for (const outcome of ["created", "already_waiting"]) {
      const serialized = JSON.stringify(await resultFor(outcome));
      expect(serialized).toBe('{"ok":true}');
      for (const leak of [/already/i, /waiting/i, /duplicate/i, /joined/i, /unconfirmed/i, /notification/i]) {
        expect(serialized, `${outcome} leaked ${leak}`).not.toMatch(leak);
      }
    }
  });

  it("NEITHER outcome awaits a provider call before answering", async () => {
    // Byte-identical results are not enough on their own. A fresh join used to
    // await two provider calls — each able to burn a 15s timeout and then retry
    // — while a duplicate returned as soon as the command answered. Comparing a
    // target address against a control address would read that off a stopwatch.
    //
    // `after()` is mocked to CAPTURE rather than run, so "no send had happened
    // when the action returned" is a fact this test observes, not an inference.
    for (const outcome of ["created", "already_waiting"]) {
      reset();
      setEnv(NEW_CLIENT_WAITLIST_SLUGS_ENV, SLUG);
      setEnv(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, SLUG);
      scenario.commandResult = outcome;

      await submitNewClientBookingWaitlistAction(form());

      expect(sends, `${outcome} sent mail before responding`).toHaveLength(0);
      expect(trace, `${outcome} awaited more than the command`).toEqual([
        "rpc:join_new_client_waitlist",
      ]);
    }
  });

  it("only the FRESH join schedules post-response work — a duplicate mails nobody", async () => {
    // The equalisation must not be "send on duplicates too": that would aim the
    // form's mail at whoever a prober names. A duplicate schedules nothing, and
    // still answers at the same point in the flow.
    reset();
    setEnv(NEW_CLIENT_WAITLIST_SLUGS_ENV, SLUG);
    setEnv(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, SLUG);
    scenario.commandResult = "already_waiting";
    await submitNewClientBookingWaitlistAction(form());
    expect(deferred).toHaveLength(0);
    await flushPostResponse();
    expect(sends).toHaveLength(0);

    reset();
    setEnv(NEW_CLIENT_WAITLIST_SLUGS_ENV, SLUG);
    setEnv(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, SLUG);
    scenario.commandResult = "created";
    await submitNewClientBookingWaitlistAction(form());
    expect(deferred).toHaveLength(1);
    await flushPostResponse();
    expect(sends.map((s) => s.namespace)).toEqual(["studio", "client"]);
  });

  it("a HANGING provider cannot slow the answer for either outcome", async () => {
    // The sharpest form of the same property: even if every send blocks
    // forever, both branches still return. Before this repair the fresh-join
    // branch would have hung here for the provider's full timeout.
    for (const outcome of ["created", "already_waiting"]) {
      reset();
      setEnv(NEW_CLIENT_WAITLIST_SLUGS_ENV, SLUG);
      setEnv(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, SLUG);
      scenario.commandResult = outcome;
      scenario.studioSendHangs = true;

      const answered = await Promise.race([
        submitNewClientBookingWaitlistAction(form()).then(() => "answered" as const),
        new Promise<"hung">((r) => setTimeout(() => r("hung"), 1_000)),
      ]);
      expect(answered, `${outcome} blocked on the provider`).toBe("answered");
    }
    // Leave nothing hanging for the next test.
    deferred.length = 0;
  });

  it("renders ONE confirmation panel, whose props cannot carry the outcome", async () => {
    // Structural, not asserted: the panel takes only a studio name, so there is
    // nothing for it to branch on. Rendering it twice must be byte-identical,
    // and it must not contain either of the removed messages.
    const { NewClientWaitlistJoinedPanel } = await import(
      "@/app/book/[slug]/NewClientWaitlistForm"
    );
    const first = renderToStaticMarkup(
      createElement(NewClientWaitlistJoinedPanel, { studioName: "Willow Electrolysis" }),
    );
    const second = renderToStaticMarkup(
      createElement(NewClientWaitlistJoinedPanel, { studioName: "Willow Electrolysis" }),
    );
    expect(second).toBe(first);
    expect(first).toContain("You\u2019re on the waitlist.");
    expect(first).not.toMatch(/already on this studio/i);
    expect(first).not.toMatch(/couldn\u2019t confirm the notification/i);
  });

  it("the whole form module contains neither removed message", async () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../../app/book/[slug]/NewClientWaitlistForm.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/already on this studio/i);
    expect(src).not.toMatch(/confirm the notification to the studio/i);
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
  // A RETURNED code means the database answered and its transaction aborted, so
  // nothing committed and "try again" is simply true. Sending the visitor to a
  // human about a request that certainly does not exist strands a real lead.
  it.each([
    ["42883", "undefined_function — the command is not deployed (rollout skew)"],
    ["PGRST202", "PostgREST has no such function in its schema cache"],
    ["57014", "query_canceled / statement timeout"],
    ["23514", "check_violation"],
    ["42501", "insufficient_privilege"],
    ["40001", "serialization_failure"],
  ])("a RETURNED database error (%s) is a definite failure, not a dead end", async (code) => {
    scenario.commandError = { code };
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({
      ok: false,
      error: FAILED,
    });
    expect(sends).toHaveLength(0);
  });

  it("NO error code is AMBIGUOUS: supabase-js reports a lost response that way", async () => {
    // supabase-js does not throw on a network failure — it catches it and
    // returns it as an `error` with an EMPTY code. The command may have
    // committed and only the answer was lost.
    scenario.commandError = { code: "" };
    expect(await submitNewClientBookingWaitlistAction(form())).toEqual({
      ok: false,
      error: UNCONFIRMED,
    });
    expect(sends).toHaveLength(0);
  });

  it.each(["08006", "08003", "08000"])(
    "SQLSTATE class 08 (%s, connection exception) stays AMBIGUOUS",
    async (code) => {
      // The connection dropped with the statement in flight: a commit that
      // landed just before the drop is indistinguishable from one that never
      // happened.
      scenario.commandError = { code };
      expect(await submitNewClientBookingWaitlistAction(form())).toEqual({
        ok: false,
        error: UNCONFIRMED,
      });
    },
  );

  it("logs which way it classified, so a misfiled code is visible", async () => {
    scenario.commandError = { code: "57014" };
    await submitNewClientBookingWaitlistAction(form());
    const definite = consoleErrors.find((l) =>
      l.includes("new_client_waitlist_command_failed"),
    );
    expect(JSON.parse(definite!)).toMatchObject({ code: "57014", outcome: "definite" });

    reset();
    scenario.commandError = { code: "08006" };
    await submitNewClientBookingWaitlistAction(form());
    const inDoubt = consoleErrors.find((l) =>
      l.includes("new_client_waitlist_command_failed"),
    );
    expect(JSON.parse(inDoubt!)).toMatchObject({ code: "08006", outcome: "in_doubt" });
  });

  it("still names the rollout skew distinctly — its fix is an operator action", async () => {
    scenario.commandError = { code: "42883" };
    await submitNewClientBookingWaitlistAction(form());
    expect(
      consoleErrors.some((l) => l.includes("new_client_waitlist_command_not_deployed")),
    ).toBe(true);
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

// ===========================================================================
// NOTIFICATION IDENTITY — one key per JOIN EVENT, not per payload
// ===========================================================================
//
// 0185 deliberately lets a REMOVED person rejoin with identical details. That
// renders a byte-identical email, so a payload-derived key would make the
// provider replay the FIRST join's response and this path would report `sent`
// for a notification nobody received. The durable entry id scopes the key.
describe("notification idempotency is scoped to the join", () => {
  it("both sends carry the durable entry id as their event scope", async () => {
    await submitNewClientBookingWaitlistAction(form());
    await flushPostResponse();
    expect(sends.map((s) => [s.namespace, s.eventScope])).toEqual([
      ["studio", "entry-1"],
      ["client", "entry-1"],
    ]);
  });

  it("a REJOIN with identical details gets a DIFFERENT scope", async () => {
    await submitNewClientBookingWaitlistAction(form());
    await flushPostResponse();
    const firstJoin = sends.map((s) => s.eventScope);

    // Same person, same details, same studio — but a new row after removal.
    reset();
    scenario.entryId = "entry-2";
    await submitNewClientBookingWaitlistAction(form());
    await flushPostResponse();

    expect(firstJoin).toEqual(["entry-1", "entry-1"]);
    expect(sends.map((s) => s.eventScope)).toEqual(["entry-2", "entry-2"]);
  });

  it("the MESSAGE is unchanged between the two joins — only the scope differs", async () => {
    await submitNewClientBookingWaitlistAction(form());
    await flushPostResponse();
    const first = sends.map((s) => ({ to: s.to, subject: s.subject, text: s.text }));
    reset();
    scenario.entryId = "entry-2";
    await submitNewClientBookingWaitlistAction(form());
    await flushPostResponse();
    expect(sends.map((s) => ({ to: s.to, subject: s.subject, text: s.text }))).toEqual(first);
  });

  it("no entry id means NO scope, never a wrong one", async () => {
    scenario.entryId = null;
    await submitNewClientBookingWaitlistAction(form());
    await flushPostResponse();
    expect(sends.map((s) => s.eventScope)).toEqual([null, null]);
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
    expect(result).toEqual({ ok: true });
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
      await flushPostResponse();
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
    await flushPostResponse();
    const line = consoleErrors.find((l) =>
      l.includes("new_client_waitlist_studio_email_not_accepted"),
    );
    expect(line).toBeDefined();
    expect(JSON.parse(line!).detail).toBe("validation_error");
  });
});
// ===========================================================================
// STAGE A IS DARK, AND ITS RECORD MUST SAY SO
// ===========================================================================
//
// This branch deploys the durable waitlist WITHOUT the public privacy
// disclosure that collecting prospect data requires — that is Stage B, and it
// is deliberately absent here. A reader of this repository must therefore be
// able to find, stated rather than inferred:
//
//   1. that this is a NEW personal-data class;
//   2. that the current public policy does NOT yet disclose it;
//   3. that there is no retention or purge policy for it yet;
//   4. and therefore that NO studio may be enabled in Stage A.
//
// Point 4 is the operative one. Everything else in this suite proves the code
// is safe while dark; this block proves the repository says WHY it must stay
// dark, so enabling a studio cannot look like an ordinary configuration change.
describe("Stage B records what closed, and what is still open", () => {
  const RISKS = readFileSync(
    path.resolve(__dirname, "../../../docs/03_SECURITY_AND_PRIVACY.md"),
    "utf8",
  );
  const ENV_DOC = readFileSync(
    path.resolve(__dirname, "../../../docs/10_DEPLOYMENT_AND_ENV.md"),
    "utf8",
  );
  const ACTION = readFileSync(
    path.resolve(__dirname, "../../../app/book/[slug]/waitlist-actions.ts"),
    "utf8",
  );

  it("ANTI-VACUITY: the durable write path is still present", () => {
    // If this stops being true the rest of this block is moot, and that must
    // be a visible decision rather than a silently passing suite.
    expect(ACTION).toContain('rpc("join_new_client_waitlist"');
  });

  it("still records it as a studio-scoped personal-data class", () => {
    expect(RISKS).toContain("New-client waitlist prospect data");
    expect(RISKS).toContain("studio-scoped personal-data class");
  });

  // WHAT STAGE B1 CLOSED. Stage A's entry said the public notice did not cover
  // a waitlist prospect; that is now false, so the register must not keep
  // saying it — a risk register that describes a resolved gap is as untrue as
  // one that hides a live gap.
  it("records the disclosure as CLOSED, and the claim is backed by the page itself", () => {
    expect(RISKS).toContain("the public privacy notice now covers it");
    expect(RISKS).not.toContain("public privacy notice does not yet cover it");
    // ANTI-VACUITY. A doc claiming closure proves nothing on its own; the
    // policy has to actually carry the coverage the register credits it with.
    const policy = readFileSync(
      path.resolve(__dirname, "../../../app/privacy/page.tsx"),
      "utf8",
    );
    expect(policy).toContain("<strong>Prospective clients</strong>");
    expect(policy).toContain("From prospective clients directly");
  });

  // WHAT STAGE B1 DID NOT CLOSE, and must therefore still say plainly.
  it("records that the export gap and the absent purge policy are STILL OPEN", () => {
    expect(RISKS).toMatch(/STILL OPEN — not in the `\/settings\/data` studio export/);
    expect(RISKS).toMatch(/STILL OPEN — no timed purge/);
    expect(RISKS).toContain("terminal `removed` transition that retains the row");
    // And the policy states that truthfully rather than inventing a period.
    expect(RISKS).toContain("does not invent one");
  });

  // CODEX (#637). Two claims in this PR were true of the DURABLE path and
  // asserted of everything. The register and the env doc are where an operator
  // reads them, so both corrections have to survive there, not only in the
  // artefacts they describe.
  it("records that the notice distinguishes the two commit points", () => {
    expect(RISKS).toContain(
      "distinguishes the two commit points rather than claiming one for everybody",
    );
    expect(RISKS).toContain("gets no record on Hone's side at all");
    // ANTI-VACUITY: the policy really does carry the distinction the register
    // credits it with, on both sides of it.
    const policy = readFileSync(
      path.resolve(__dirname, "../../../app/privacy/page.tsx"),
      "utf8",
    );
    expect(policy).toContain("<strong>Where the waitlist is kept with us</strong>");
    expect(policy).toContain("<strong>Where it is not kept with us</strong>");
    expect(policy).not.toContain("we store it for that studio");
  });

  it("warns that a green deploy-time check is NOT proof of activation", () => {
    expect(ENV_DOC).toContain("A green check is not proof of activation.");
    expect(ENV_DOC).toContain("CONFIGURED NORMALISED ENTRIES");
    expect(ENV_DOC).toContain("upper bound on what could activate");
    // ANTI-VACUITY: the script really does report entries rather than studios.
    const gate = readFileSync(
      path.resolve(__dirname, "../../../scripts/check-production-env-gates.mjs"),
      "utf8",
    );
    expect(gate).toContain("distinct normalised configuration");
    expect(gate).not.toMatch(/explicitly enables/);
  });

  // CODEX (#637) P2-B. The gate treated the current app-writer slug shape as
  // the database's domain and FAILED a build on anything outside it, which
  // would have blocked activation for a legacy studio whose slug the column
  // still permits. The doc an operator reads must record that it no longer
  // adjudicates.
  // CODEX (#637) round 4. The register summarised WAIT-01 as two outcomes —
  // accepted, or "not accepted therefore failed" — after §6 had already been
  // corrected to three. A readiness record that contradicts the published
  // policy is worse than one that says less.
  it("records all THREE WAIT-01 outcomes, not two", () => {
    expect(RISKS).toContain("It states all three WAIT-01 outcomes, not two");
    expect(RISKS).toContain("where Hone knows the request was not sent");
    expect(RISKS).toContain("an ambiguous send is deliberately");
    expect(RISKS).toMatch(/\*\*not\*\* reported as a failure/);
    // ...and the old two-way summary is gone.
    expect(RISKS).not.toContain("is not accepted is reported as failed");
    // ANTI-VACUITY: the policy really does carry the same three-way split.
    const policy = readFileSync(
      path.resolve(__dirname, "../../../app/privacy/page.tsx"),
      "utf8",
    );
    expect(policy).toContain("If we know the request was not sent");
    expect(policy).toContain("If the outcome is uncertain instead");
    expect(policy).toContain("accepted the message for sending");
  });

  // The runtime module promised a deploy-time protection that had been
  // deliberately withdrawn — a maintainer reading it would rely on it.
  it("the runtime module describes the gate as report-only", () => {
    const mod = readFileSync(
      path.resolve(__dirname, "../../../lib/booking/new-client-waitlist.ts"),
      "utf8",
    );
    expect(mod).toContain("WHAT REPLACED IT IS REPORT-ONLY");
    // The canonical sentences, verbatim — same text the gate script authors.
    expect(mod).toContain("Gate 4 is report-only.");
    expect(mod).toContain(
      "It does not fail the\n * build solely because of NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS.",
    );
    expect(mod).toContain("Runtime exact-membership is the activation control.");
    expect(mod).toMatch(/DO NOT RELY ON THE GATE TO CATCH A MISTYPED SLUG/);
    // The withdrawn promise is gone, in the present tense.
    expect(mod).not.toMatch(/production build (?:still )?aborts/i);
    // ...while the properties that ARE still true survive.
    expect(mod).toMatch(/THERE IS NO GLOBAL ENABLE, BY CONSTRUCTION/);
    expect(mod).toMatch(/DEFAULT OFF/);
  });

  it("records that the deploy-time check is report-only, not an adjudicator", () => {
    expect(ENV_DOC).toContain("report-only");
    expect(ENV_DOC).toContain("not the domain of `studios.slug`");
    expect(ENV_DOC).toContain("non-blocking WARNING");
    expect(RISKS).toContain("report-only");
    // ANTI-VACUITY: the script really cannot fail on this variable any more.
    const gate = readFileSync(
      path.resolve(__dirname, "../../../scripts/check-production-env-gates.mjs"),
      "utf8",
    );
    const guard = gate.slice(gate.indexOf("Gate 4, WAIT-02B Stage-B durable waitlist"));
    expect(guard).toMatch(/WARN stage-b-durable-waitlist-env/);
    expect(guard).not.toMatch(/failed = true/);
    expect(guard).not.toMatch(/FAIL stage-b-durable-waitlist-env/);
    // ...and the premise the fix rests on is recorded where it can be checked.
    const m0010 = readFileSync(
      path.resolve(__dirname, "../../../supabase/migrations/0010_booking_v1.sql"),
      "utf8",
    );
    expect(m0010).toContain("add column if not exists slug text");
    expect(m0010).toContain("add constraint studios_slug_unique unique (slug)");
    expect(m0010).not.toMatch(/studios_slug_(?:format|shape|length)_check/);
  });

  it("states the CONSEQUENCE: activation stays explicit, and has not been taken", () => {
    expect(RISKS).toContain("PRODUCTION STILL ENABLES ZERO STUDIOS");
    expect(RISKS).toContain("Activation remains an explicit operator step");
    // ...and the same law is stated where an operator would actually go to
    // turn the flag on, not only in the risk register.
    expect(ENV_DOC).toContain("PRODUCTION CURRENTLY NAMES NO STUDIO");
    expect(ENV_DOC).toContain("release decision, never a configuration tweak");
    // The §13 notice process is named at the point of activation, because that
    // is the decision an operator is about to make.
    expect(ENV_DOC).toContain("confirm the §13 notice process");
  });
});

// ===========================================================================
// DARK-DEPLOY LAW — NO STUDIO IS ENABLED BY THIS BRANCH
// ===========================================================================
//
// Stage A ships the durable path and turns it on for nobody. The behavioural
// half is proved above (flag unset -> no command runs, exact-match only,
// derived from the server-resolved slug). This block proves the OTHER half,
// which no runtime test can see: that nothing committed to this repository
// actually names a studio.
describe("no studio is enabled at merge time", () => {
  const REPO = path.resolve(__dirname, "../../../");
  const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

  /**
   * Every committed CONFIGURATION-CAPABLE file that names the durable flag.
   *
   * The census exists to catch surfaces that could silently configure or
   * activate the flag — runtime readers, env/config files, seeds, deployment
   * scripts, and harnesses that deliberately set it. Pure prose cannot, which
   * is why Markdown is excluded.
   *
   * `docs/production/migration-state.json` is excluded BY EXACT PATH for the
   * same reason: it is prose-in-JSON. It is the canonical hosted-state record,
   * and since the 0185 apply it truthfully states that the variable
   * NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS was measured ABSENT from the
   * Vercel Production environment. Naming the variable exactly is the point of
   * that record, and it must not be made vaguer to satisfy a grep — but the
   * file cannot configure anything, so it does not belong in this census.
   *
   * The exclusion is deliberately ONE PATH. Not `*.json`, not `docs/**`, not
   * `docs/production/**`: any of those would let a future config-capable file
   * slip in under the same umbrella.
   */
  function filesNamingTheFlag(): string[] {
    return execSync(
      `git grep -l NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS -- . ':!*.md' ':!docs/production/migration-state.json' || true`,
      { cwd: REPO },
    )
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
  }

  it("only the module that reads it, the e2e harness and its own tests name it", () => {
    // A short, closed list. Anything else naming this flag — a config file, a
    // seed, a deploy script — is how a studio would get switched on quietly, so
    // a new entry here has to be a deliberate decision rather than a diff
    // nobody looked at.
    expect(filesNamingTheFlag()).toEqual([
      "e2e/helpers/local-env.ts",
      "e2e/new-client-waitlist.spec.ts",
      "lib/booking/new-client-waitlist.ts",
      "scripts/check-production-env-gates.mjs",
      "tests/app/book/new-client-waitlist-action.test.ts",
      "tests/app/book/new-client-waitlist-durable-commit.test.ts",
      // Stage B1. Pins that the deploy-time report still names the variable,
      // and that it describes the configured list rather than adjudicating it.
      "tests/app/privacy/waitlist-prospect-disclosure.test.ts",
      "tests/scripts/check-production-env-gates.test.ts",
    ]);
  });

  it("the module that reads it assigns it NO value", () => {
    // It declares the NAME of the variable and reads process.env; it must never
    // seed a default membership.
    const mod = read("lib/booking/new-client-waitlist.ts");
    expect(mod).toContain(
      'NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV =\n  "NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS"',
    );
    expect(mod).not.toMatch(/NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS\s*[:=]\s*"[^"]+"/);
  });

  it("the ONLY assignment anywhere is the e2e harness, and only to its reserved slug", () => {
    const env = read("e2e/helpers/local-env.ts");
    const assigned = [
      ...env.matchAll(/NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS:\s*"([^"]*)"/g),
    ].map((m) => m[1]);
    expect(assigned).toEqual(["e2e-waitlist-p0"]);
  });

  it("WILLOW IS NOT CONFIGURED INTO THE FLAG ANYWHERE", () => {
    // Deliberately about ASSIGNMENTS, not mentions. `lib/booking/new-client-
    // waitlist.ts` legitimately names willow-electrolysis in a comment
    // explaining why matching is exact ("willow-electrolysis" must not silence
    // "willow-electrolysis-archive"); banning the word would fail on that
    // explanation while a real assignment elsewhere slipped through. What must
    // never exist is a VALUE for this variable naming a real studio.
    const assignments: string[] = [];
    for (const file of filesNamingTheFlag()) {
      for (const m of read(file).matchAll(
        /NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS"?\s*[:=]\s*"([^"]*)"/g,
      )) {
        assignments.push(m[1]);
      }
    }
    // Exactly one assignment exists in the whole repository, and it is the
    // reserved e2e slug.
    expect(assignments).toEqual(["e2e-waitlist-p0"]);
    for (const value of assignments) {
      expect(value.toLowerCase()).not.toContain("willow");
    }
  });

  it("no committed environment file sets it", () => {
    // .env.local.example is the template an operator copies; if the flag were
    // pre-filled there, a fresh deploy would arrive already enabled.
    const example = read(".env.local.example");
    expect(example).not.toContain("NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS");
  });
});
