import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// WAIT-CAPACITY-01 — the owner's open/close controls, wired
// ===========================================================================
//
// THESE PROVE THE SEAM, NOT THE RULE. The one-open-round invariant, the owner
// re-derivation and the refusal vocabulary are all 0192's and are proved in the
// DB suites. What can go wrong HERE is the wiring: calling the wrong command,
// trusting a browser-supplied tenant, reading a refusal as a success, writing
// the table directly, or putting an internal code in front of a practitioner.

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { revalidatePath } from "next/cache";
import {
  closeInvitationsAction,
  closeInvitationsFormAction,
  startInvitingAction,
  startInvitingFormAction,
} from "@/app/(app)/settings/waitlist/capacity-actions";
import {
  coerceConsumed,
  readRoundConsumed,
} from "@/lib/waitlist/round-consumption-server";
import { CAPACITY_EXHAUSTED_COPY } from "@/lib/waitlist/invitation-capacity";
import { invitationRefusalCopy } from "@/lib/waitlist/invite-to-book-contract";

const STUDIO = "11111111-1111-1111-1111-111111111111";
const ACTOR = "22222222-2222-2222-2222-222222222222";
const OTHER_STUDIO = "99999999-9999-9999-9999-999999999999";

type RpcCall = { name: string; args: Record<string, unknown> };
let calls: RpcCall[] = [];
let tableTouches: string[] = [];

function arrangeRpc(reply: { data?: unknown; error?: { code?: string } | null }) {
  vi.mocked(createAdminClient).mockReturnValue({
    // A DIRECT TABLE WRITE IS A FAILURE, NOT A FALLBACK. 0192 revokes all DML
    // on the round table from every role, so anything reaching here is a design
    // error rather than something to answer.
    from: (table: string) => {
      tableTouches.push(table);
      throw new Error(`capacity must not touch tables directly: ${table}`);
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null });
    },
  } as unknown as ReturnType<typeof createAdminClient>);
}

function arrangeActor(role: "owner" | "member" = "owner", userId: string | null = ACTOR) {
  vi.mocked(getCurrentPractitionerWithStudio).mockResolvedValue({
    practitioner: { role, user_id: userId },
    studio: { id: STUDIO },
  } as unknown as Awaited<ReturnType<typeof getCurrentPractitionerWithStudio>>);
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  calls = [];
  tableTouches = [];
  vi.clearAllMocks();
});
afterEach(() => vi.resetAllMocks());

describe("opening an invitation capacity", () => {
  it("calls the DB command with a SERVER-derived studio and actor", async () => {
    arrangeActor();
    arrangeRpc({ data: [{ result: "opened", round_id: "r1" }] });
    const res = await startInvitingAction(form({ allowance: "3" }));
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("open_new_client_waitlist_admission_round");
    expect(calls[0].args).toEqual({
      p_studio_id: STUDIO,
      p_actor_user_id: ACTOR,
      p_allowance: 3,
    });
    expect(tableTouches).toEqual([]);
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/settings/waitlist");
  });

  it("MATRIX 8 — a browser-supplied studio or practitioner is ignored entirely", async () => {
    // The form can carry anything. Neither value may become authority: the
    // studio and the actor come from the SESSION, and the command re-derives
    // ownership from them again.
    arrangeActor();
    arrangeRpc({ data: [{ result: "opened", round_id: "r1" }] });
    await startInvitingAction(
      form({
        allowance: "2",
        studio_id: OTHER_STUDIO,
        p_studio_id: OTHER_STUDIO,
        practitioner_id: "attacker",
        p_actor_user_id: "attacker",
      }),
    );
    expect(calls[0].args.p_studio_id).toBe(STUDIO);
    expect(calls[0].args.p_actor_user_id).toBe(ACTOR);
    expect(JSON.stringify(calls[0].args)).not.toContain(OTHER_STUDIO);
    expect(JSON.stringify(calls[0].args)).not.toContain("attacker");
  });

  it("MATRIX 7 — a member cannot open one, and no command is issued", async () => {
    arrangeActor("member");
    arrangeRpc({ data: [{ result: "opened" }] });
    const res = await startInvitingAction(form({ allowance: "3" }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toContain("Only the studio owner");
    expect(calls, "a non-owner must not reach the command at all").toHaveLength(0);
  });

  it("MATRIX 13 — NEGATIVE CONTROL: the owner check is what refuses a member", async () => {
    // If the role gate were removed, this member WOULD reach the command. The
    // test above is only meaningful because the same arrangement succeeds for
    // an owner -- so the refusal is the gate, not the fixture.
    arrangeActor("owner");
    arrangeRpc({ data: [{ result: "opened" }] });
    expect((await startInvitingAction(form({ allowance: "3" }))).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("refuses an allowance that was never chosen, and never guesses one", async () => {
    arrangeActor();
    arrangeRpc({ data: [{ result: "opened" }] });
    for (const bad of ["", "0", "-1", "2.5", "abc", "101"]) {
      calls = [];
      const res = await startInvitingAction(form({ allowance: bad }));
      expect(res.ok, `allowance ${JSON.stringify(bad)} must be refused`).toBe(false);
      expect(calls, "no command may be issued for an unusable allowance").toHaveLength(0);
    }
    // And the absent field, which is not the same as an empty one.
    const res = await startInvitingAction(new FormData());
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("MATRIX 9 — a second simultaneous open is refused in the practitioner's words", async () => {
    // The DB's one-open-round index is the authority; this asserts the action
    // reports its verdict safely rather than pretending it opened one.
    arrangeActor();
    arrangeRpc({ data: [{ result: "round_already_open", round_id: null }] });
    const res = await startInvitingAction(form({ allowance: "3" }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toBe("You already have an invitation capacity open.");
    expect(vi.mocked(revalidatePath)).not.toHaveBeenCalled();
  });

  it("never renders an unrecognised refusal code", async () => {
    arrangeActor();
    arrangeRpc({ data: [{ result: "some_new_code_from_a_later_migration" }] });
    const res = await startInvitingAction(form({ allowance: "3" }));
    expect(res.ok).toBe(false);
    const message = res.ok === false ? res.message : "";
    expect(message).not.toContain("some_new_code_from_a_later_migration");
    expect(message).toBe("We couldn't set your invitation capacity. Please try again.");
  });

  it("a transport error is a refusal, never a silent success", async () => {
    arrangeActor();
    arrangeRpc({ data: null, error: { code: "PGRST301" } });
    const res = await startInvitingAction(form({ allowance: "3" }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).not.toContain("PGRST301");
  });
});

describe("closing an invitation capacity", () => {
  it("MATRIX 5 — calls the DB command and never opens another", async () => {
    arrangeActor();
    arrangeRpc({ data: "closed" });
    const res = await closeInvitationsAction();
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("close_new_client_waitlist_admission_round");
    expect(calls[0].args).toEqual({ p_studio_id: STUDIO, p_actor_user_id: ACTOR });
    expect(
      calls.filter((c) => c.name === "open_new_client_waitlist_admission_round"),
      "closing must never start the next capacity",
    ).toHaveLength(0);
    expect(tableTouches).toEqual([]);
  });

  it("MATRIX 7 — a member cannot close one", async () => {
    arrangeActor("member");
    arrangeRpc({ data: "closed" });
    const res = await closeInvitationsAction();
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("reports the DB's refusals without their vocabulary", async () => {
    arrangeActor();
    for (const [code, expected] of [
      ["no_round_open", "You don't have an invitation capacity open."],
      ["live_offers_outstanding", "We couldn't close your invitation capacity. Please try again."],
    ] as const) {
      calls = [];
      arrangeRpc({ data: code });
      const res = await closeInvitationsAction();
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.message).toBe(expected);
      expect(res.ok === false && res.message).not.toContain(code);
    }
  });

  it("a practitioner with no user id is refused rather than passed as null", async () => {
    // The command reads `invalid_input` for a null actor; refusing here says
    // something useful instead of surfacing that.
    arrangeActor("owner", null);
    arrangeRpc({ data: "closed" });
    const res = await closeInvitationsAction();
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("the consumed count", () => {
  it("is READ from the database, never recomputed", async () => {
    arrangeRpc({ data: 2 });
    expect(await readRoundConsumed("r1")).toBe(2);
    expect(calls).toEqual([
      { name: "waitlist_admission_round_consumed", args: { p_round_id: "r1" } },
    ]);
  });

  it("P1 4020704225 — a NULL answer with NO error is UNKNOWN, not zero", async () => {
    // THE EXACT CODEX CASE. The old code did
    //     typeof data === "number" ? data : Number(data)
    // and `Number(null)` is 0 -- so "the count could not be established" became
    // "zero seats used", which reads as a completely empty capacity and OFFERS
    // invitations the database may refuse. There is no error here to catch it.
    arrangeRpc({ data: null, error: null });
    expect(await readRoundConsumed("r1")).toBeNull();
  });

  it("accepts ONLY a non-negative integer, as 0192 declares", async () => {
    // `waitlist_admission_round_consumed(uuid) returns integer`. Anything else
    // is a shape this RPC does not produce, and guessing at it is how the null
    // case became a zero.
    for (const ok of [0, 1, 7, 100]) {
      arrangeRpc({ data: ok });
      expect(await readRoundConsumed("r1"), `${ok} is a legitimate count`).toBe(ok);
    }
    const rejected: [string, unknown][] = [
      ["null", null],
      ["undefined", undefined],
      ["numeric string", "3"],
      ["empty string", ""],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
      ["negative", -1],
      ["non-integer", 1.5],
      ["empty array", []],
      ["array of one", [2]],
      ["object", { count: 2 }],
      ["boolean", true],
    ];
    for (const [label, data] of rejected) {
      arrangeRpc({ data });
      expect(await readRoundConsumed("r1"), `${label} must be UNKNOWN`).toBeNull();
    }
  });

  it("the coercion is the thing being tested, not the transport", () => {
    // Stated directly too, so a future refactor that moves the RPC cannot
    // quietly take the validation with it.
    expect(coerceConsumed(0)).toBe(0);
    expect(coerceConsumed(4)).toBe(4);
    for (const bad of [null, undefined, "3", Number.NaN, Infinity, -1, 1.5, [], {}, true]) {
      expect(coerceConsumed(bad), `${JSON.stringify(bad) ?? "undefined"} must be null`).toBeNull();
    }
    // NEGATIVE CONTROL for the control: broad coercion would have passed the
    // first three of these. This is what the old implementation did.
    const oldBehaviour = (d: unknown) => (typeof d === "number" ? d : Number(d));
    expect(oldBehaviour(null), "the defect, reproduced").toBe(0);
    expect(oldBehaviour([]), "and its siblings").toBe(0);
    expect(oldBehaviour("3")).toBe(3);
  });

  it("an RPC error is UNKNOWN too", async () => {
    arrangeRpc({ data: null, error: { code: "42501" } });
    expect(await readRoundConsumed("r1")).toBeNull();
  });
});

describe("P1 4020704233 — the consumed reader is not a Server Action", () => {
  const actionSrc = readFileSync(
    join(process.cwd(), "app/(app)/settings/waitlist/capacity-actions.ts"),
    "utf8",
  );
  const readerSrc = readFileSync(
    join(process.cwd(), "lib/waitlist/round-consumption-server.ts"),
    "utf8",
  );

  it("the action module is 'use server', so nothing service-role-reading may be exported from it", () => {
    // Every exported async function in a "use server" module is a Server Action
    // boundary: Next ships an id for it and the browser can invoke it. A reader
    // that took an arbitrary round id and went straight to service-role was
    // therefore remotely invocable with any uuid.
    expect(actionSrc.trimStart().startsWith('"use server"')).toBe(true);
    // NOTHING EXPORTED, and no service-role consumed call. The comment in that
    // file names the reader to say why it is elsewhere, so the check is on
    // EXPORTS and CALLS rather than on the word appearing at all.
    const exported = [...actionSrc.matchAll(/^export (?:async )?function (\w+)/gm)].map(
      (m) => m[1],
    );
    expect(exported, "the reader must not be exported from an action module").not.toContain(
      "readRoundConsumed",
    );
    const executable = actionSrc
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(executable).not.toContain("waitlist_admission_round_consumed");
    expect(executable).not.toContain("readRoundConsumed");
    // And the exports that DO remain are the intended four.
    expect(exported.sort()).toEqual([
      "closeInvitationsAction",
      "closeInvitationsFormAction",
      "startInvitingAction",
      "startInvitingFormAction",
    ]);
  });

  it("the reader lives behind server-only and is NOT in a 'use server' module", () => {
    expect(readerSrc.trimStart().startsWith('import "server-only"')).toBe(true);
    // THE DIRECTIVE, NOT THE PHRASE. A comment in this file explains why it is
    // not an action module, and matching the bare substring would flag that
    // explanation. A directive is a STATEMENT on its own line, so that is what
    // is checked.
    const directives = readerSrc
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l === '"use server";' || l === "'use server';" || l === '"use server"');
    expect(directives, "a server-only module must not also be an action surface").toEqual([]);
    // It may reach service-role, because 0192 grants this function to
    // service_role alone -- but only through the RPC, never a table.
    expect(readerSrc).toContain("waitlist_admission_round_consumed");
    expect(readerSrc).not.toMatch(/\.from\(/);
  });

  it("only the server-rendered page calls it, never a form", () => {
    // The round id must come from the page's own RLS-scoped read, not from
    // anything a browser can set.
    const callers = ["app/(app)/settings/waitlist/page.tsx"];
    for (const c of callers) {
      const src = readFileSync(join(process.cwd(), c), "utf8");
      expect(src).toContain("readRoundConsumed");
    }
    const panel = readFileSync(
      join(process.cwd(), "components/waitlist/invitation-capacity-panel.tsx"),
      "utf8",
    );
    expect(panel, "the client panel must not reach the reader").not.toContain(
      "readRoundConsumed",
    );
    expect(panel).not.toContain("round-consumption-server");
  });
});

describe("P2 4020704236 — open/close failures reach the owner", () => {
  it("START returns the typed refusal through the action-state shape", async () => {
    arrangeActor();
    arrangeRpc({ data: [{ result: "round_already_open" }] });
    const state = await startInvitingFormAction(null, form({ allowance: "3" }));
    expect(state.ok).toBe(false);
    expect(state.ok === false && state.message).toBe(
      "You already have an invitation capacity open.",
    );
  });

  it("CLOSE returns the typed refusal through the action-state shape", async () => {
    arrangeActor();
    arrangeRpc({ data: "no_round_open" });
    const state = await closeInvitationsFormAction(null, new FormData());
    expect(state.ok).toBe(false);
    expect(state.ok === false && state.message).toBe(
      "You don't have an invitation capacity open.",
    );
  });

  it("NEGATIVE CONTROL — the wrappers no longer return void", async () => {
    // The defect was that these discarded CapacityActionResult, so a refusal
    // was indistinguishable from a successful no-op. A void return cannot carry
    // a message, so the shape itself is the guard.
    arrangeActor();
    arrangeRpc({ data: [{ result: "opened" }] });
    const ok = await startInvitingFormAction(null, form({ allowance: "1" }));
    expect(ok, "a wrapper that returned void would be undefined here").toBeDefined();
    expect(ok).toEqual({ ok: true });
  });

  it("every failure the owner can cause carries practitioner-safe copy", async () => {
    arrangeActor();
    const cases: [string, { data?: unknown; error?: { code?: string } }][] = [
      ["round_already_open race", { data: [{ result: "round_already_open" }] }],
      ["transport failure", { data: null, error: { code: "PGRST301" } }],
      ["unexpected DB result", { data: [{ result: "something_unmapped" }] }],
    ];
    for (const [label, reply] of cases) {
      arrangeRpc(reply);
      const state = await startInvitingFormAction(null, form({ allowance: "3" }));
      expect(state.ok, label).toBe(false);
      const msg = state.ok === false ? state.message : "";
      expect(msg.length, `${label} must say something`).toBeGreaterThan(20);
      for (const leak of ["round_already_open", "PGRST301", "something_unmapped", "admission"]) {
        expect(msg.toLowerCase(), `${label} leaked ${leak}`).not.toContain(leak.toLowerCase());
      }
    }
    // The invalid allowance never reaches the database at all.
    calls = [];
    const bad = await startInvitingFormAction(null, form({ allowance: "0" }));
    expect(bad.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("MATRIX 12 — internal refusal codes never reach a practitioner", () => {
  it("translates the two capacity refusals into the product's words", () => {
    expect(invitationRefusalCopy("no_admission_round")).toBe(
      "Set your invitation capacity before inviting someone to book.",
    );
    expect(invitationRefusalCopy("admission_round_full")).toBe(CAPACITY_EXHAUSTED_COPY);
  });

  it("NEGATIVE CONTROL — the exact production leak cannot recur", async () => {
    // A practitioner saw: "No invitation was created (no_admission_round)."
    // THE SHAPE of the old default is what made that possible, so the source is
    // checked for it directly: no template literal may interpolate the code.
    const src = readFileSync(
      join(process.cwd(), "lib/waitlist/invite-to-book-contract.ts"),
      "utf8",
    );
    const fn = src.slice(src.indexOf("export function invitationRefusalCopy"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body, "the refusal copy must never interpolate its code").not.toMatch(/\$\{code\}/);
  });

  it("no refusal code this contract knows renders raw", async () => {
    // Every code the type admits, swept — so a code added later without copy
    // fails here rather than in front of someone.
    const codes = [
      "no_admission_round",
      "admission_round_full",
      "not_owner",
      "not_found",
      "already_invited",
      "invalid_service",
      "invalid_scope_dates",
    ] as const;
    for (const code of codes) {
      const copy = invitationRefusalCopy(code as Parameters<typeof invitationRefusalCopy>[0]);
      expect(copy, `raw code leaked for ${code}`).not.toContain(code);
      expect(copy).not.toMatch(/admission round/i);
      expect(copy.length).toBeGreaterThan(20);
    }
  });
});
