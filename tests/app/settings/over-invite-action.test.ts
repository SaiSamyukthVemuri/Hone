import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "owner" as string,
  fit: { ok: true as boolean, fit: 5 },
  preview: { ok: true, result: "ok", liveCount: 8, expiringWithin24h: 1, selected: 3, admissible: 3 } as Record<string, unknown>,
  create: { ok: true, result: "created", batchId: "b", quantity: 3, extraRequested: 3, liveCount: 8 } as Record<string, unknown>,
  calls: [] as string[],
  createArgs: null as Record<string, unknown> | null,
  logs: [] as string[],
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { role: h.role, user_id: "11111111-1111-4111-8111-111111111111" },
    studio: { id: "22222222-2222-4222-8222-222222222222", timezone: "UTC" },
  }),
}));
vi.mock("@/lib/waitlist/send-time-fit", () => ({ computeConsultationFit: async () => h.fit }));
vi.mock("@/lib/waitlist/over-invite-deliver", () => ({ deliverIssued: async () => "accepted", mayStillSend: async () => true }));
vi.mock("@/lib/waitlist/over-invite-port", () => ({
  previewSelection: async () => (h.calls.push("preview"), h.preview),
  createBatch: async (_db: unknown, input: Record<string, unknown>) => (h.calls.push("create"), (h.createArgs = input), h.create),
  claimItems: async () => (h.calls.push("claim"), { ok: true, items: [] }),
  admitBatchItem: async () => ({ ok: true, result: "no_capacity" }),
  settleItem: async () => ({ ok: true, result: "settled" }),
  replaceInvitation: async () => ({ ok: true, result: "no_live_invitation" }),
}));

import { sendOverInviteAction } from "@/app/(app)/settings/waitlist/over-invite/actions";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const KEY = "33333333-3333-4333-8333-333333333333";
function form(over: Record<string, string | string[]> = {}) {
  const f = new FormData();
  const base: Record<string, string | string[]> = {
    batchKey: KEY, serviceId: U(900), windowDays: "7", allowedWeekdays: "",
    shownFit: "5", shownActive: "8", shownExtra: "3", confirmed: "on", entryId: [U(1), U(2), U(3)],
  };
  for (const [k, v] of Object.entries({ ...base, ...over })) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
}
const run = (f: FormData) => sendOverInviteAction({ state: "idle" }, f);

beforeEach(() => {
  h.role = "owner";
  h.fit = { ok: true, fit: 5 };
  h.preview = { ok: true, result: "ok", liveCount: 8, expiringWithin24h: 1, selected: 3, admissible: 3 };
  h.create = { ok: true, result: "created", batchId: "b", quantity: 3, extraRequested: 3, liveCount: 8 };
  h.calls = []; h.createArgs = null; h.logs = [];
  for (const m of ["log", "error", "warn"] as const) vi.spyOn(console, m).mockImplementation((...a) => { h.logs.push(a.join(" ")); });
});

describe("over-invite action", () => {
  it("refuses when not confirmed, and says so nothing is created", async () => {
    const r = await run(form({ confirmed: "" }));
    expect(r).toMatchObject({ state: "notice" });
    expect(h.calls).not.toContain("create");
  });
  it("says so when nobody is chosen", async () => {
    const r = await run(form({ entryId: [] }));
    expect(r).toMatchObject({ state: "notice" });
    expect(h.calls).toEqual([]);
  });
  it("refuses a non-owner before any command", async () => {
    h.role = "practitioner";
    const r = await run(form());
    expect(r).toMatchObject({ state: "notice" });
    expect(h.calls).toEqual([]);
  });
  it("a malformed batch key or service is refused", async () => {
    expect(await run(form({ batchKey: "abc" }))).toMatchObject({ state: "notice" });
    expect(await run(form({ serviceId: "x" }))).toMatchObject({ state: "notice" });
    expect(h.calls).toEqual([]);
  });
  it("forged shown numbers never change what is created; the server's own are used", async () => {
    await run(form({ shownFit: "5", shownActive: "8", shownExtra: "3" }));
    expect(h.createArgs).toMatchObject({ fit: 5, shownLiveCount: 8, confirmed: true });
    expect(h.createArgs?.entryIds).toEqual([U(1), U(2), U(3)]);
  });
  it("shown numbers that differ from the server's re-ask and create nothing", async () => {
    const r = await run(form({ shownActive: "2" }));
    expect(r).toMatchObject({ state: "reconfirm", active: 8, extra: 3, fit: 5 });
    expect(h.calls).not.toContain("create");
  });
  it("a changed extra (some chosen are not invitable) re-asks with the server's count", async () => {
    h.preview = { ...h.preview, admissible: 2 };
    const r = await run(form());
    expect(r).toMatchObject({ state: "reconfirm", extra: 2 });
  });
  it("duplicate posted ids reach the command once each", async () => {
    await run(form({ entryId: [U(1), U(1), U(2), U(3)] }));
    expect(h.createArgs?.entryIds).toEqual([U(1), U(2), U(3)]);
  });
  it("a zero or exhausted capacity still sends a confirmed batch", async () => {
    h.fit = { ok: true, fit: 0 };
    const r = await run(form({ shownFit: "0" }));
    expect(h.calls).toContain("create");
    expect(r).toMatchObject({ state: "progress" });
  });
  it("material_change from the database re-asks and queues nothing", async () => {
    h.create = { ok: true, result: "material_change", batchId: null, quantity: 3, extraRequested: null, liveCount: 9 };
    const r = await run(form());
    expect(r).toMatchObject({ state: "reconfirm", active: 9 });
    expect(h.calls).not.toContain("claim");
  });
  it("a reused key and an entry already in a batch are refused with their own sentences", async () => {
    h.create = { ok: true, result: "key_reused", batchId: null, quantity: null, extraRequested: null, liveCount: null };
    expect(await run(form())).toMatchObject({ state: "notice" });
    h.create = { ok: true, result: "entry_in_other_batch", batchId: null, quantity: null, extraRequested: null, liveCount: null };
    expect(await run(form())).toMatchObject({ state: "notice" });
    expect(h.calls).not.toContain("claim");
  });
  it("the fit being unreadable sends nothing", async () => {
    h.fit = { ok: false, fit: 0 };
    expect(await run(form())).toMatchObject({ state: "notice" });
    expect(h.calls).toEqual([]);
  });
  it("a thrown command yields a fixed sentence and logs nothing", async () => {
    h.create = null as never;
    const r = await run(form());
    expect(r).toMatchObject({ state: "notice" });
    expect(h.logs.join("\n")).not.toMatch(/@|token|TOKEN/);
  });

  // A key is canonical or it is refused BEFORE any lookup or command: no trimming, no Unicode whitespace, so the app and the database can never
  // disagree about whether two spellings are the same key.
  const PADS = ["\t", "\n", "\r", "\u00a0", "\u2003", "\u200b", " "];
  for (const pad of PADS) {
    const name = JSON.stringify(pad);
    it(`a batch key padded with ${name} is refused and nothing is created`, async () => {
      for (const key of [pad + KEY, KEY + pad]) {
        h.calls = [];
        const r = await run(form({ batchKey: key }));
        expect(r).toMatchObject({ state: "notice" });
        expect(h.calls).toEqual([]);
      }
    });
    it(`a service id padded with ${name} is refused and nothing is created`, async () => {
      for (const v of [pad + U(900), U(900) + pad]) {
        h.calls = [];
        const r = await run(form({ serviceId: v }));
        expect(r).toMatchObject({ state: "notice" });
        expect(h.calls).toEqual([]);
      }
    });
    it(`a window or weekday value padded with ${name} is refused and nothing is created`, async () => {
      for (const o of [{ windowDays: "7" + pad }, { windowDays: pad + "7" }, { allowedWeekdays: "1,2" + pad }, { allowedWeekdays: pad + "1" }] as Record<string, string>[]) {
        h.calls = [];
        const r = await run(form(o));
        expect(r).toMatchObject({ state: "notice" });
        expect(h.calls).toEqual([]);
      }
    });
    it(`an entry id padded with ${name} is dropped, never sent to the command`, async () => {
      await run(form({ entryId: [U(1), U(2) + pad, pad + U(3)] }));
      expect(h.createArgs?.entryIds).toEqual([U(1)]);
    });
  }
});
