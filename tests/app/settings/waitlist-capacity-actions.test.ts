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
  readRoundConsumed,
  startInvitingAction,
} from "@/app/(app)/settings/waitlist/capacity-actions";
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

  it("is null — not zero — when it cannot be established", async () => {
    // Zero would present a spent capacity as fully available.
    arrangeRpc({ data: null, error: { code: "42501" } });
    expect(await readRoundConsumed("r1")).toBeNull();
    arrangeRpc({ data: "not a number" });
    expect(await readRoundConsumed("r1")).toBeNull();
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
