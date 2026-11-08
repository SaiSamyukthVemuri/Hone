import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPOSER_FIELD_NAMES } from "@/lib/waitlist/b4-invitation-draft";

// ===========================================================================
// 0324 -- THE SEND COMPUTES ITS OWN FIT, AND THE ROUND IS PLUMBING
//
// The database guard enforces the fit it is given, so the only thing standing
// between a crafted client and an inflated limit is that the fit comes from the
// SEND server action and from nowhere else. This file proves that two ways: by
// behaviour (a forged field changes nothing) and by source (no browser input
// path can name a fit).
//
// RESIDUAL, NOT CLAIMED CLOSED: availability can change between the fit
// computation here and the database's studio lock. See
// tests/db/waitlist-atomic-send-allowance.db.test.ts "the residual race".
// ===========================================================================

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
let admitReplies: Array<{ data: unknown; error: unknown }> = [];
let openReply: { data: unknown; error: unknown } = { data: [{ result: "opened" }], error: null };
let fitReply: { ok: boolean; fit?: number; firstDate?: string } = { ok: true, fit: 3, firstDate: "2026-09-22" };
const fitCalls: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "open_new_client_waitlist_admission_round") return openReply;
      if (name === "close_new_client_waitlist_admission_round") return { data: [{ result: "closed" }], error: null };
      if (name === "admit_new_client_waitlist_entry") return admitReplies.shift() ?? { data: null, error: { code: "XX000" } };
      return { data: null, error: null };
    },
  }),
}));
vi.mock("@/lib/waitlist/send-time-fit", () => ({
  computeConsultationFit: async (input: Record<string, unknown>) => {
    fitCalls.push(input);
    return fitReply;
  },
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { role: "owner", user_id: "user-1" },
    studio: { id: "studio-1", name: "Studio", timezone: "UTC", slug: "studio" },
  }),
}));
vi.mock("@/lib/booking/session-actor", () => ({
  sessionActor: async () => ({ studioId: "studio-1", actorUserId: "user-1" }),
}));

const { admissionCommandAdapter } = await import("@/lib/waitlist/invite-to-book-adapter");

const INPUT = {
  entryId: "11111111-1111-4111-8111-111111111111",
  scope: { serviceId: "svc-1", windowDays: 14, allowedWeekdays: [1, 2] as number[] | null },
};
const names = () => calls.map((c) => c.name);
const admitCalls = () => calls.filter((c) => c.name === "admit_new_client_waitlist_entry");

beforeEach(() => {
  calls.length = 0;
  fitCalls.length = 0;
  admitReplies = [];
  openReply = { data: [{ result: "opened" }], error: null };
  fitReply = { ok: true, fit: 3, firstDate: "2026-09-22" };
});

describe("the fit is computed at send, from the exact selections being sent", () => {
  it("passes the computed fit as p_fit and computes it from this send's own scope", async () => {
    admitReplies = [{ data: [{ result: "no_capacity" }], error: null }];
    await admissionCommandAdapter.inviteToBook(INPUT);
    expect(fitCalls).toHaveLength(1);
    expect(fitCalls[0]).toMatchObject({
      studioId: "studio-1",
      serviceId: "svc-1",
      windowDays: 14,
      allowedWeekdays: [1, 2],
    });
    expect(admitCalls()[0].args.p_fit).toBe(3);
  });

  it("IGNORES a fit forged into the input", async () => {
    admitReplies = [{ data: [{ result: "no_capacity" }], error: null }];
    const forged = {
      ...INPUT,
      fit: 9999,
      p_fit: 9999,
      scope: { ...INPUT.scope, fit: 9999 },
    } as unknown as typeof INPUT;
    await admissionCommandAdapter.inviteToBook(forged);
    expect(admitCalls()[0].args.p_fit).toBe(3);
  });

  it("a fit that cannot be computed sends nothing and says it could not find out", async () => {
    fitReply = { ok: false };
    const out = await admissionCommandAdapter.inviteToBook(INPUT);
    expect(admitCalls()).toHaveLength(0);
    expect(out).toMatchObject({ state: "indeterminate" });
  });

  it("no_capacity is a definite refusal, in words, and is not retried", async () => {
    admitReplies = [{ data: [{ result: "no_capacity" }], error: null }];
    const out = await admissionCommandAdapter.inviteToBook(INPUT);
    expect(out).toEqual({ state: "refused", code: "no_capacity" });
    expect(admitCalls()).toHaveLength(1);
  });
});

describe("the admission round is plumbing", () => {
  it("opens a round at the maximum allowance before admitting, with no owner input", async () => {
    admitReplies = [{ data: [{ result: "no_capacity" }], error: null }];
    await admissionCommandAdapter.inviteToBook(INPUT);
    expect(names().slice(0, 2)).toEqual(["open_new_client_waitlist_admission_round", "admit_new_client_waitlist_entry"]);
    expect(calls[0].args).toMatchObject({ p_studio_id: "studio-1", p_actor_user_id: "user-1", p_allowance: 100 });
  });

  it("an already-open round is fine", async () => {
    openReply = { data: [{ result: "round_already_open" }], error: null };
    admitReplies = [{ data: [{ result: "no_capacity" }], error: null }];
    await admissionCommandAdapter.inviteToBook(INPUT);
    expect(admitCalls()).toHaveLength(1);
  });

  it("a round that cannot be opened sends nothing", async () => {
    openReply = { data: [{ result: "not_owner" }], error: null };
    const out = await admissionCommandAdapter.inviteToBook(INPUT);
    expect(admitCalls()).toHaveLength(0);
    expect(out).toMatchObject({ state: "indeterminate" });
  });

  it("a full round is rotated once and the send retried on the fresh round", async () => {
    admitReplies = [
      { data: [{ result: "round_full" }], error: null },
      { data: [{ result: "no_capacity" }], error: null },
    ];
    const out = await admissionCommandAdapter.inviteToBook(INPUT);
    expect(names()).toEqual([
      "open_new_client_waitlist_admission_round",
      "admit_new_client_waitlist_entry",
      "close_new_client_waitlist_admission_round",
      "open_new_client_waitlist_admission_round",
      "admit_new_client_waitlist_entry",
    ]);
    expect(out).toEqual({ state: "refused", code: "no_capacity" });
  });

  it("a lost answer is never retried (the invitation may already exist)", async () => {
    admitReplies = [{ data: null, error: { code: "XX000" } }];
    const out = await admissionCommandAdapter.inviteToBook(INPUT);
    expect(admitCalls()).toHaveLength(1);
    expect(out).toMatchObject({ state: "indeterminate" });
  });
});

describe("source tripwire: no browser input path can name a fit", () => {
  const ROOT = join(__dirname, "..", "..", "..");
  const strip = (s: string) => s.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const read = (p: string) => strip(readFileSync(join(ROOT, p), "utf8"));
  const ADAPTER = read("lib/waitlist/invite-to-book-adapter.ts");
  const ACTIONS = read("app/(app)/settings/waitlist/invite-actions.ts");
  const DRAFT = read("lib/waitlist/b4-invitation-draft.ts");
  const CONTRACT = read("lib/waitlist/invite-to-book-contract.ts");

  it("p_fit is assigned from the server's own computation and nothing else", () => {
    const assignments = ADAPTER.match(/p_fit:\s*[^,\n]+/g) ?? [];
    expect(assignments).toEqual(["p_fit: fit.fit"]);
    expect(ADAPTER).toMatch(/const fit = await computeConsultationFit\(/);
  });

  it("the send action reads no field named like a fit or a cap", () => {
    expect(ACTIONS).not.toMatch(/formData\.get\(\s*["'`][^"'`]*(fit|cap)[^"'`]*["'`]/i);
    expect(ACTIONS).not.toMatch(/\bfit\b/i);
  });

  it("no composer field is a fit, an allowance or a capacity", () => {
    for (const name of Object.values(COMPOSER_FIELD_NAMES)) expect(name).not.toMatch(/fit|cap|allowance/i);
    expect(DRAFT).not.toMatch(/["']p_fit["']|["']fit["']\s*:/);
  });

  it("the contract's input type has no fit", () => {
    const input = CONTRACT.match(/export type InviteToBookInput = \{[\s\S]*?\n\};/)?.[0] ?? "";
    expect(input, "InviteToBookInput not found").not.toBe("");
    expect(input).not.toMatch(/\bfit\b|\bp_fit\b|allowance|capacity/i);
  });

  it("the shared fit module imports no admin client and takes none from a caller's input", () => {
    const FIT = read("lib/waitlist/send-time-fit.ts");
    expect(FIT).not.toMatch(/admin-server/);
  });
});
