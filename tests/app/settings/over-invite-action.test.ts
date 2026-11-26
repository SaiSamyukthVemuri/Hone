import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "owner" as string,
  fit: { ok: true as boolean, fit: 5 },
  service: { data: { id: "svc" }, error: null } as { data: unknown; error: unknown },
  serviceFilters: [] as Array<[string, unknown]>,
  preview: { ok: true, result: "ok", liveCount: 8, expiringWithin24h: 1, selected: 3, admissible: 3 } as Record<string, unknown>,
  create: { ok: true, result: "created", batchId: "b", quantity: 3, extraRequested: 3, liveCount: 8 } as Record<string, unknown>,
  calls: [] as string[],
  createArgs: null as Record<string, unknown> | null,
  logs: [] as string[],
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: (k: string, v: unknown) => (h.serviceFilters.push([k, v]), chain),
      maybeSingle: async () => (h.calls.push("service"), h.service),
    });
    return { from: () => chain };
  },
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { role: h.role, user_id: "11111111-1111-4111-8111-111111111111" },
    studio: { id: "22222222-2222-4222-8222-222222222222", timezone: "UTC" },
  }),
}));
vi.mock("@/lib/waitlist/send-time-fit", () => ({ computeConsultationFit: async () => h.fit }));
vi.mock("@/lib/waitlist/over-invite-deliver", () => ({ deliverIssued: async () => "accepted", mayStillSend: async () => "sendable" as const }));
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
  h.service = { data: { id: "svc" }, error: null }; h.serviceFilters = [];
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
  it("a zero estimate still sends a confirmed batch once the owner has acknowledged that the invited may find no times", async () => {
    h.fit = { ok: true, fit: 0 };
    const r = await run(form({ shownFit: "0", ackNoTimes: "on" }));
    expect(h.calls).toContain("create");
    expect(r).toMatchObject({ state: "progress" });
  });
  describe("the posted service must be this studio's own active service", () => {
    it("a service that is not found saves no batch, even at a zero estimate that never looks at it", async () => {
      h.fit = { ok: true, fit: 0 };
      h.service = { data: null, error: null };
      const r = await run(form({ shownFit: "0", ackNoTimes: "on" }));
      expect(r).toMatchObject({ state: "notice", notice: expect.stringContaining("Nothing was sent") });
      expect(h.calls).not.toContain("preview");
      expect(h.calls).not.toContain("create");
    });
    it("a failed service read saves no batch", async () => {
      h.service = { data: null, error: { code: "XX000" } };
      expect(await run(form())).toMatchObject({ state: "notice" });
      expect(h.calls).not.toContain("create");
    });
    it("the lookup is scoped to the studio from the session and to active services", async () => {
      await run(form());
      expect(h.serviceFilters).toEqual([["id", U(900)], ["studio_id", "22222222-2222-4222-8222-222222222222"], ["active", true]]);
    });
  });
  describe("at a zero estimate the SERVER requires the no-times acknowledgement", () => {
    const NEED = "Tick the box to confirm: These clients may open the invitation and find no times to book. Nothing was sent.";
    it("refuses a send that omits it, creates nothing, and says what to tick", async () => {
      h.fit = { ok: true, fit: 0 };
      const r = await run(form({ shownFit: "0" }));
      expect(r).toEqual({ state: "notice", notice: NEED });
      expect(h.calls).not.toContain("create");
      expect(h.calls).not.toContain("claim");
    });
    it("accepts only the exact value on: anything else is not an acknowledgement", async () => {
      h.fit = { ok: true, fit: 0 };
      for (const v of ["", "true", "yes", "ON", "1", " on"]) {
        h.calls = [];
        expect(await run(form({ shownFit: "0", ackNoTimes: v }))).toEqual({ state: "notice", notice: NEED });
        expect(h.calls).not.toContain("create");
      }
    });
    it("the confirmed box alone does not stand in for it", async () => {
      h.fit = { ok: true, fit: 0 };
      expect(await run(form({ shownFit: "0", confirmed: "on" }))).toEqual({ state: "notice", notice: NEED });
    });
    it("is decided from the SERVER's fit: a form that claims a nonzero estimate cannot skip it (it is asked again on the new numbers first)", async () => {
      h.fit = { ok: true, fit: 0 };
      const r = await run(form({ shownFit: "5" }));
      expect(r).toMatchObject({ state: "reconfirm", fit: 0 });
      expect(h.calls).not.toContain("create");
    });
    it("is not demanded when appointments are estimated", async () => {
      h.fit = { ok: true, fit: 5 };
      const r = await run(form());
      expect(h.calls).toContain("create");
      expect(r).toMatchObject({ state: "progress" });
    });
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
    expect(h.calls).toEqual(["service"]);
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
