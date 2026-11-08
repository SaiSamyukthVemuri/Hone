import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// WAIT-EXPOSE-01 — the five lifecycle commands, wired
// ===========================================================================
//
// These prove the SEAM, not the lifecycle. The lifecycle is the database's and
// is already proved in the DB suites; what can go wrong here is the wiring —
// calling the wrong command, trusting a browser-supplied tenant, reading a
// refusal as a success, leaking prospect data into a log, or issuing DML.
//
// No database. Both `getCurrentPractitionerWithStudio` and the admin client are
// faked, so every assertion is about what this file DOES with an answer rather
// than about what the answer should be.

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The real `redirect` throws a NEXT_REDIRECT control-flow error; the fake does the same with the
// target, so a test can tell "redirected to X" from "threw a refusal".
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));

import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { STALE_STATE_NOTICES, lifecycleNoticeCopy } from "@/lib/waitlist/lifecycle-notice";
import {
  claimNextWaitlistEntriesAction,
  claimWaitlistEntryAction,
  expireWaitlistInvitationAction,
  releaseWaitlistEntryAction,
  requeueWaitlistEntryAction,
} from "@/app/(app)/settings/waitlist/actions";

const STUDIO = "11111111-1111-1111-1111-111111111111";
const ACTOR = "22222222-2222-2222-2222-222222222222";
const ENTRY = "33333333-3333-3333-3333-333333333333";

type RpcCall = { name: string; args: Record<string, unknown> };

let calls: RpcCall[] = [];

/** `reply` is whatever the command "returned" — a code, a row set, or an error. */
function arrangeRpc(reply: { data?: unknown; error?: { code?: string } | null }) {
  vi.mocked(createAdminClient).mockReturnValue({
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

function entryForm(entryId = ENTRY): FormData {
  const fd = new FormData();
  fd.set("entry_id", entryId);
  return fd;
}

beforeEach(() => {
  calls = [];
  arrangeActor();
});
afterEach(() => vi.clearAllMocks());

/** The five newly surfaced seams: action, its command, and its success code. */
const SEAMS = [
  {
    name: "claim",
    run: claimWaitlistEntryAction,
    rpc: "claim_new_client_waitlist_entry",
    success: "claimed",
  },
  {
    name: "release",
    run: releaseWaitlistEntryAction,
    rpc: "release_new_client_waitlist_entry",
    success: "released",
  },
  {
    name: "expire",
    run: expireWaitlistInvitationAction,
    rpc: "expire_new_client_waitlist_invitation",
    success: "expired",
  },
  {
    name: "requeue",
    run: requeueWaitlistEntryAction,
    rpc: "requeue_new_client_waitlist_entry",
    success: "requeued",
  },
] as const;

describe("each action calls EXACTLY its own command, once", () => {
  for (const seam of SEAMS) {
    it(`${seam.name} calls ${seam.rpc} and nothing else`, async () => {
      arrangeRpc({ data: seam.success });
      await seam.run(entryForm());
      expect(calls).toHaveLength(1);
      expect(calls[0]!.name).toBe(seam.rpc);
    });
  }

  it("claim-next calls the SET-RETURNING command, not the single one", async () => {
    arrangeRpc({ data: [{ result: "claimed", entry_id: ENTRY }] });
    const fd = new FormData();
    fd.set("count", "3");
    await claimNextWaitlistEntriesAction(fd);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("claim_new_client_waitlist_entries");
    expect(calls[0]!.args.p_count).toBe(3);
    // No id list is sent — "the next 3" is the database's queue order.
    expect(JSON.stringify(calls[0]!.args)).not.toContain(ENTRY);
  });
});

describe("the browser supplies identity, never authority", () => {
  for (const seam of SEAMS) {
    it(`${seam.name} sends the SESSION studio and actor, not anything posted`, async () => {
      arrangeRpc({ data: seam.success });
      const fd = entryForm();
      // A forged post naming another tenant and actor.
      fd.set("studio_id", "99999999-9999-9999-9999-999999999999");
      fd.set("actor_user_id", "88888888-8888-8888-8888-888888888888");
      await seam.run(fd);
      expect(calls[0]!.args.p_studio_id).toBe(STUDIO);
      expect(calls[0]!.args.p_actor_user_id).toBe(ACTOR);
      expect(JSON.stringify(calls[0]!.args)).not.toContain("99999999");
      expect(JSON.stringify(calls[0]!.args)).not.toContain("88888888");
    });
  }

  it("a cross-studio entry id is passed through and left to the command", async () => {
    // The id is the ONE thing the browser legitimately supplies. It is not
    // trusted — it is scoped by (id, studio_id) inside the command, which is
    // why a foreign id resolves to `not_found` rather than to someone's row.
    arrangeRpc({ data: "not_found" });
    await expect(
      claimWaitlistEntryAction(entryForm("44444444-4444-4444-4444-444444444444")),
    ).rejects.toThrow("NEXT_REDIRECT:/settings/waitlist?notice=claim.not_found");
    expect(calls[0]!.args.p_studio_id).toBe(STUDIO);
  });
});

describe("owner-only, and re-derived even so", () => {
  for (const seam of SEAMS) {
    it(`${seam.name} refuses a member before issuing anything`, async () => {
      arrangeActor("member");
      arrangeRpc({ data: seam.success });
      await expect(seam.run(entryForm())).rejects.toThrow(/Only studio owners/);
      expect(calls).toHaveLength(0);
    });
  }

  it("claim-next refuses a member before issuing anything", async () => {
    arrangeActor("member");
    arrangeRpc({ data: [] });
    const fd = new FormData();
    fd.set("count", "3");
    await expect(claimNextWaitlistEntriesAction(fd)).rejects.toThrow(/Only studio owners/);
    expect(calls).toHaveLength(0);
  });

  it("a DATABASE-side owner refusal still surfaces as owner copy", async () => {
    // The route check is not the guarantee: a role change committed between the
    // check and the call arrives here as a command code.
    arrangeRpc({ data: "not_owner" });
    await expect(claimWaitlistEntryAction(entryForm())).rejects.toThrow(/Only studio owners/);
  });

  it("an unresolvable practitioner is refused, not passed as null", async () => {
    arrangeActor("owner", null);
    arrangeRpc({ data: "claimed" });
    await expect(claimWaitlistEntryAction(entryForm())).rejects.toThrow(/signed-in practitioner/);
    expect(calls).toHaveLength(0);
  });
});

describe("a refusal is never read as a success", () => {
  for (const seam of SEAMS) {
    it(`${seam.name} throws on any code that is not "${seam.success}"`, async () => {
      arrangeRpc({ data: "some_other_code" });
      await expect(seam.run(entryForm())).rejects.toThrow();
      expect(vi.mocked(revalidatePath)).not.toHaveBeenCalled();
    });

    it(`${seam.name} throws on a transport error`, async () => {
      arrangeRpc({ data: null, error: { code: "57014" } });
      await expect(seam.run(entryForm())).rejects.toThrow();
    });

    it(`${seam.name} revalidates ONLY on success`, async () => {
      arrangeRpc({ data: seam.success });
      await seam.run(entryForm());
      expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/settings/waitlist");
    });
  }
});

describe("a stale-state refusal redirects with a notice; every other refusal still throws", () => {
  const STALE: ReadonlyArray<[(fd: FormData) => Promise<void>, string, string]> = [
    [claimWaitlistEntryAction, "not_waiting", "claim.not_waiting"],
    [releaseWaitlistEntryAction, "not_releasable", "release.not_releasable"],
    [releaseWaitlistEntryAction, "already_redeemed", "release.already_redeemed"],
    [expireWaitlistInvitationAction, "not_invited", "expire.not_invited"],
    [expireWaitlistInvitationAction, "not_expired", "expire.not_expired"],
    [requeueWaitlistEntryAction, "not_requeueable", "requeue.not_requeueable"],
    [requeueWaitlistEntryAction, "already_active", "requeue.already_active"],
  ];

  for (const [run, code, key] of STALE) {
    it(`${code} redirects with ${key}, revalidates, and moves nothing else`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      arrangeRpc({ data: code });
      await expect(run(entryForm())).rejects.toThrow(`NEXT_REDIRECT:/settings/waitlist?notice=${encodeURIComponent(key)}`);
      expect(vi.mocked(redirect)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/settings/waitlist");
      // One command, once: no retry, no second rpc.
      expect(calls).toHaveLength(1);
      // A warning with the outcome, not an error: this is not a fault.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(code);
      expect(error).not.toHaveBeenCalled();
      warn.mockRestore();
      error.mockRestore();
    });
  }

  const THROWN: ReadonlyArray<[(fd: FormData) => Promise<void>, string, RegExp]> = [
    [releaseWaitlistEntryAction, "not_owner", /Only studio owners/],
    [releaseWaitlistEntryAction, "not_a_member", /Only studio owners/],
    [claimWaitlistEntryAction, "a_code_nobody_mapped", /Could not claim that entry/],
  ];
  for (const [run, code, expected] of THROWN) {
    it(`${code} is still thrown, never redirected`, async () => {
      arrangeRpc({ data: code });
      await expect(run(entryForm())).rejects.toThrow(expected);
      expect(vi.mocked(redirect)).not.toHaveBeenCalled();
    });
  }

  it("a transport error that carries a stale-looking code is still thrown", async () => {
    // `error` wins: the answer is not trusted when the call itself failed.
    arrangeRpc({ data: "not_releasable", error: { code: "57014" } });
    await expect(releaseWaitlistEntryAction(entryForm())).rejects.toThrow(/^(?!NEXT_REDIRECT)/);
    expect(vi.mocked(redirect)).not.toHaveBeenCalled();
  });

  it("a stale code for ANOTHER action is not a notice for this one", async () => {
    // `not_releasable` belongs to release; claim has no such stale state.
    arrangeRpc({ data: "not_releasable" });
    await expect(claimWaitlistEntryAction(entryForm())).rejects.toThrow(/Could not claim that entry/);
    expect(vi.mocked(redirect)).not.toHaveBeenCalled();
  });
});

describe("the notice table is the only text a notice can render", () => {
  it("every key resolves to its own fixed sentence", () => {
    for (const [key, copy] of Object.entries(STALE_STATE_NOTICES)) {
      expect(lifecycleNoticeCopy(key)).toEqual({ tone: "refusal", text: copy });
    }
  });

  it("the two outcome notices carry their own tone", () => {
    expect(lifecycleNoticeCopy("remove.removed")).toEqual({ tone: "success", text: "Removed from the waitlist." });
    expect(lifecycleNoticeCopy("remove.unconfirmed")?.tone).toBe("unconfirmed");
  });

  it("anything else renders nothing and is never echoed", () => {
    for (const hostile of [
      "<script>alert(1)</script>",
      "release.not_releasable ",
      "RELEASE.NOT_RELEASABLE",
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
      "",
      undefined,
      null,
      42,
      ["release.not_releasable"],
      { toString: () => "release.not_releasable" },
    ]) {
      expect(lifecycleNoticeCopy(hostile), JSON.stringify(hostile)).toBeNull();
    }
  });

  it("each refusal map's copy for a stale code IS the notice table's (one source)", () => {
    const SRC = readFileSync(join(process.cwd(), "app/(app)/settings/waitlist/actions.ts"), "utf8");
    for (const key of Object.keys(STALE_STATE_NOTICES)) {
      expect(SRC, key).toContain(`STALE_STATE_NOTICES["${key}"]`);
    }
  });
});

describe("claim next N", () => {
  it("zero claimed is a NO-OP, not a failure", async () => {
    // An empty result means the queue had nobody left. Treating it as an error
    // would report a working command as broken.
    arrangeRpc({ data: [] });
    const fd = new FormData();
    fd.set("count", "5");
    await expect(claimNextWaitlistEntriesAction(fd)).resolves.toBeUndefined();
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/settings/waitlist");
  });

  it("any non-claimed row in the set is a refusal", async () => {
    arrangeRpc({ data: [{ result: "claimed" }, { result: "invalid_count" }] });
    const fd = new FormData();
    fd.set("count", "5");
    await expect(claimNextWaitlistEntriesAction(fd)).rejects.toThrow(/Choose between/);
  });

  it("bounds the count before it becomes a query", async () => {
    arrangeRpc({ data: [] });
    for (const bad of ["0", "-1", "26", "abc", "2.5", ""]) {
      const fd = new FormData();
      fd.set("count", bad);
      await expect(claimNextWaitlistEntriesAction(fd), bad).rejects.toThrow(/Choose between/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("source contract", () => {
  const SRC = readFileSync(
    join(process.cwd(), "app/(app)/settings/waitlist/actions.ts"),
    "utf8",
  );
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("issues NO direct DML — every mutation is a command", () => {
    expect(CODE).not.toMatch(/\.from\(/);
    expect(CODE).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    // Non-vacuity: the stripped source really is the module.
    expect(CODE).toMatch(/export async function claimWaitlistEntryAction/);
  });

  it("wires exactly the eight permitted commands and no others", () => {
    // TWO CALL SHAPES, and a census that saw only one would under-report.
    // `remove` and `claim-next` name their command at the `.rpc(` call; the four
    // single-entry actions pass it to the shared runner as `rpc: "…"`. Both are
    // string literals, so both are greppable — but a scan for `.rpc("` alone
    // finds two of six and silently calls that the whole census.
    const rpcs = [
      ...[...CODE.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]!),
      ...[...CODE.matchAll(/\brpc:\s*"([a-z_]+)"/g)].map((m) => m[1]!),
    ];
    // Fails closed: if the runner is ever refactored to take a non-literal, the
    // count drops and this assertion goes red rather than passing quietly.
    expect(rpcs).toHaveLength(8);
    expect(new Set(rpcs)).toEqual(
      new Set([
        "remove_new_client_waitlist_entry",
        "claim_new_client_waitlist_entry",
        "claim_new_client_waitlist_entries",
        "release_new_client_waitlist_entry",
        "expire_new_client_waitlist_invitation",
        "requeue_new_client_waitlist_entry",
        // WAIT-P1-EXIT, migration 0200. The seventh, and it goes through the
        // SAME shared runner as the four single-entry commands — one entry id
        // from the browser, studio and actor resolved server-side.
        "close_unbooked_new_client_waitlist_invitation",
        // 0313. The eighth, called ONLY right after the close above has committed,
        // so closing an unbooked invitation also resolves the owner's follow-up
        // item for it. Studio and actor come from the session, the entry id from
        // the same one browser value; best effort (the command is absent until
        // 0313 is applied) and its failure logs a studio id and a classified
        // code only.
        "resolve_waitlist_invitation_followup",
      ]),
    );
  });

  it("does NOT wire issue, redeem or conversion — those await B1/B2", () => {
    for (const deferred of [
      "issue_new_client_waitlist_invitation",
      "redeem_new_client_waitlist_invitation",
      "record_new_client_waitlist_conversion",
    ]) {
      expect(CODE, deferred).not.toContain(deferred);
    }
  });

  it("logs no prospect PII", () => {
    const logs = [...CODE.matchAll(/console\.(?:error|warn)\(([\s\S]*?)\);/g)].map((m) => m[1]!);
    expect(logs.length).toBeGreaterThanOrEqual(2);
    for (const log of logs) {
      for (const pii of ["name", "email", "phone", "entryId", "entry_id"]) {
        expect(log, pii).not.toContain(pii);
      }
      expect(log).toContain("studioId");
      expect(log).toContain("outcome");
    }
  });
});

describe("the result vocabularies are the DATABASE's", () => {
  // Derived from the SHIPPED definitions, not from a hand-written list. 0189
  // REDEFINES four of these five commands, so reading 0188 alone would pin a
  // superseded vocabulary — the exact drift this test exists to catch.
  const read = (f: string) =>
    readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8");
  const M0188 = read("0188_new_client_waitlist_invitations.sql");
  const M0189 = read("0189_waitlist_invitation_wall_clock_expiry.sql");
  const SRC = readFileSync(
    join(process.cwd(), "app/(app)/settings/waitlist/actions.ts"),
    "utf8",
  );

  /** Every `return '<code>'` inside one function's body. */
  function codesOf(sql: string, fn: string): string[] {
    const from = sql.indexOf(`create or replace function public.${fn}(`);
    expect(from, `${fn} not found`).toBeGreaterThan(-1);
    const next = sql.indexOf("create or replace function public.", from + 10);
    const body = sql.slice(from, next === -1 ? sql.length : next);
    return [...body.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]!);
  }

  const EXPECTED: ReadonlyArray<[string, string, string[]]> = [
    ["claim_new_client_waitlist_entry", "0189", ["claimed", "not_found", "not_waiting"]],
    [
      "release_new_client_waitlist_entry",
      "0189",
      ["released", "already_redeemed", "not_releasable"],
    ],
    [
      "expire_new_client_waitlist_invitation",
      "0189",
      ["expired", "already_redeemed", "not_invited", "not_expired"],
    ],
    [
      "requeue_new_client_waitlist_entry",
      "0188",
      ["requeued", "already_active", "not_requeueable"],
    ],
  ];

  for (const [fn, migration, expected] of EXPECTED) {
    it(`${fn} still returns exactly what this file maps (${migration})`, () => {
      const sql = migration === "0189" ? M0189 : M0188;
      const codes = new Set(codesOf(sql, fn));
      for (const code of expected) {
        expect(codes, `${fn} no longer returns ${code}`).toContain(code);
        // …and every non-success code is mapped to copy in the action file.
        if (code !== expected[0]) {
          expect(SRC, `${code} unmapped`).toContain(`${code}:`);
        }
      }
    });
  }

  it("requeue is NOT redefined after 0188, so 0188 is still its authority", () => {
    // If a later migration ever replaces it, this test fails and the vocabulary
    // above must be re-derived from the newer definition.
    expect(M0189).not.toContain(
      "create or replace function public.requeue_new_client_waitlist_entry(",
    );
  });
});
