import { beforeEach, describe, expect, it, vi } from "vitest";

// The admit and replace results carry a delivery email, a name and the raw token. Prove none of the three reaches a logger, an error reporter, a
// redirect, a thrown error or a returned result, on success and on every failure path.

const h = vi.hoisted(() => ({
  mode: "success" as string,
  unknownRun: false,
  replaces: 0,
  spied: [] as string[],
  SECRET: { token: "RAWTOKEN-s3cr3t-xyz", email: "private.person@example.test", name: "Privatename Surname" },
}));
const SECRET = h.SECRET;

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { h.spied.push(`redirect:${u}`); throw new Error("NEXT_REDIRECT"); } }));
vi.mock("@sentry/nextjs", () => ({ captureException: (...a: unknown[]) => h.spied.push(`sentry:${JSON.stringify(a)}`), captureMessage: (...a: unknown[]) => h.spied.push(`sentry:${JSON.stringify(a)}`) }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async (...a: unknown[]) => { h.spied.push(`alert:${JSON.stringify(a)}`); } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (name: string) => {
      const c: any = {
        select: () => c, eq: () => c, in: () => c, order: () => c, limit: () => c, range: () => c,
        maybeSingle: async () => ({ data: { state: h.unknownRun ? "unknown" : "failed", reason_class: "delivery_refused" }, error: null }),
        then: (r: (v: unknown) => void) => r({ data: name === "waitlist_invitation_batches" ? [{ id: "b", confirmed_at: "2026-11-20", quantity: 1, fit_shown: 0, live_shown: 0 }] : [{ id: "00000000-0000-4000-8000-000000000050", entry_id: "00000000-0000-4000-8000-000000000001" }], error: null }),
      };
      return c;
    },
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { role: "owner", user_id: "11111111-1111-4111-8111-111111111111" },
    studio: { id: "22222222-2222-4222-8222-222222222222", timezone: "UTC" },
  }),
}));
vi.mock("@/lib/waitlist/send-time-fit", () => ({ computeConsultationFit: async () => ({ ok: true, fit: 0 }) }));
vi.mock("@/lib/waitlist/over-invite-deliver", () => ({
  mayStillSend: async () => true,
  deliverIssued: async (_s: string, issued: { rawToken: string; deliveryEmail: string | null; deliveryName: string | null }) => {
    // The deliverer holds the secrets; a failing mode throws an error that CARRIES them, as a careless provider error might.
    if (h.mode === "deliver_throws") throw new Error(`provider failed for ${issued.deliveryEmail} ${issued.rawToken} ${issued.deliveryName}`);
    return h.mode === "delivery_refused" ? "refused" : "accepted";
  },
}));
vi.mock("@/lib/waitlist/over-invite-port", async () => {
  const real = await vi.importActual<typeof import("@/lib/waitlist/over-invite-port")>("@/lib/waitlist/over-invite-port");
  const issued = { invitationId: "inv", rawToken: h.SECRET.token, issuedAt: new Date(), expiresAt: new Date(), deliveryEmail: h.SECRET.email, deliveryName: h.SECRET.name };
  let queue: { itemId: string; entryId: string }[] = [];
  return {
    ...real,
    previewSelection: async (_d: unknown, i: { entryIds: string[] }) => ({ ok: true, result: "ok", liveCount: 0, expiringWithin24h: 0, selected: i.entryIds.length, admissible: i.entryIds.length }),
    createBatch: async (_d: unknown, i: { entryIds: string[] }) => {
      queue = i.entryIds.map((entryId, n) => ({ itemId: `it${n}`, entryId }));
      return { ok: true, result: "created", batchId: "b", quantity: i.entryIds.length, extraRequested: i.entryIds.length, liveCount: 0 };
    },
    claimItems: async () => {
      if (h.mode === "claim_fails") return { ok: false, code: "unavailable" };
      const take = queue.splice(0, 25);
      return { ok: true, items: take.map((t) => ({ ...t, batchId: "b", studioId: "22222222-2222-4222-8222-222222222222", actorUserId: "a", serviceId: "s", startDate: "2026-12-01", endDate: "2026-12-07", allowedWeekdays: null, ttlHours: 48 })) };
    },
    admitBatchItem: async () => {
      if (h.mode === "admit_throws") throw new Error(`rpc exploded ${h.SECRET.token} ${h.SECRET.email}`);
      if (h.mode === "admit_refused") return { ok: true, result: "no_capacity" };
      return { ok: true, result: "admitted", issued };
    },
    settleItem: async () => (h.mode === "settle_fails" ? { ok: false, code: "unavailable" } : { ok: true, result: "settled" }),
    replaceInvitation: async () => (h.replaces++, h.mode === "replace_refused" ? { ok: true, result: "refused" } : { ok: true, result: "replaced", issued }),
  };
});
vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as never);

import { retryFailedDeliveriesAction as retryOverInviteDeliveriesAction, retryUnknownDeliveriesAction, sendOverInviteAction } from "@/app/(app)/settings/waitlist/over-invite/actions";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function sendForm() {
  const f = new FormData();
  f.append("batchKey", "33333333-3333-4333-8333-333333333333");
  f.append("serviceId", U(900));
  f.append("windowDays", "7");
  f.append("allowedWeekdays", "");
  f.append("shownFit", "0"); f.append("shownActive", "0"); f.append("shownExtra", "2");
  f.append("confirmed", "on");
  f.append("entryId", U(1)); f.append("entryId", U(2));
  return f;
}
const MODES = ["success", "admit_refused", "admit_throws", "deliver_throws", "delivery_refused", "settle_fails", "claim_fails"];

beforeEach(() => {
  h.spied = [];
  h.replaces = 0;
  h.unknownRun = false;
  for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a) => { h.spied.push(`console.${m}:${a.map((x) => (x instanceof Error ? `${x.message}${x.stack}` : String(typeof x === "object" ? JSON.stringify(x) : x))).join(" ")}`); });
});
const leaked = (text: string) => Object.values(SECRET).filter((s) => text.includes(s));

describe("no secret reaches a logger, reporter, redirect or result", () => {
  for (const mode of MODES) {
    it(`send: ${mode}`, async () => {
      h.mode = mode;
      let out = "";
      try {
        out = JSON.stringify(await sendOverInviteAction({ state: "idle" }, sendForm()));
      } catch (e) {
        out = `THROWN:${(e as Error).message}`;
      }
      expect(leaked(out), `result body (${mode})`).toEqual([]);
      expect(leaked(h.spied.join("\n")), `logger/reporter/redirect (${mode})`).toEqual([]);
    });
  }
  for (const mode of ["success", "replace_refused", "deliver_throws", "delivery_refused", "settle_fails"]) {
    it(`retry: ${mode}`, async () => {
      h.mode = mode;
      const f = new FormData();
      f.append("confirmRetry", "on");
      let out = "";
      try {
        out = JSON.stringify(await retryOverInviteDeliveriesAction({ state: "idle" }, f));
      } catch (e) {
        out = `THROWN:${(e as Error).message}`;
      }
      expect(leaked(out)).toEqual([]);
      expect(leaked(h.spied.join("\n"))).toEqual([]);
      if (mode !== "settle_fails") expect(h.replaces, "the retry really ran (not vacuous)").toBeGreaterThanOrEqual(1);
    });
    it(`retry unknown: ${mode}`, async () => {
      h.mode = mode;
      h.unknownRun = true;
      const f = new FormData();
      f.append("confirmRetryUnknown", "on");
      let out = "";
      try {
        out = JSON.stringify(await retryUnknownDeliveriesAction({ state: "idle" }, f));
      } catch (e) {
        out = `THROWN:${(e as Error).message}`;
      }
      expect(leaked(out)).toEqual([]);
      expect(leaked(h.spied.join("\n"))).toEqual([]);
      if (mode !== "settle_fails") expect(h.replaces, "the unknown retry really ran (not vacuous)").toBeGreaterThanOrEqual(1);
    });
  }
  it("the spies are live: a deliberate console.error is captured (non-vacuity)", () => {
    console.error(SECRET.token);
    expect(leaked(h.spied.join("\n"))).toEqual([SECRET.token]);
  });
});
