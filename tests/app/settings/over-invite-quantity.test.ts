import { beforeEach, describe, expect, it, vi } from "vitest";

// Sam's quantity rule: whatever the owner confirms is processed IN FULL. A claim chunk is pagination of the one batch, never a cap.

const h = vi.hoisted(() => ({
  queue: [] as { itemId: string; entryId: string }[],
  claimCalls: [] as number[],
  admitted: [] as string[],
  settled: [] as string[],
  failClaimAfter: Infinity,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { role: "owner", user_id: "11111111-1111-4111-8111-111111111111" },
    studio: { id: "22222222-2222-4222-8222-222222222222", timezone: "UTC" },
  }),
}));
vi.mock("@/lib/waitlist/send-time-fit", () => ({ computeConsultationFit: async () => ({ ok: true, fit: 0 }) }));
vi.mock("@/lib/waitlist/over-invite-deliver", () => ({ deliverIssued: async () => "accepted", mayStillSend: async () => true }));
vi.mock("@/lib/waitlist/over-invite-port", () => ({
  previewSelection: async (_d: unknown, i: { entryIds: string[] }) => ({ ok: true, result: "ok", liveCount: 0, expiringWithin24h: 0, selected: i.entryIds.length, admissible: i.entryIds.length }),
  createBatch: async (_d: unknown, i: { entryIds: string[] }) => {
    h.queue = i.entryIds.map((entryId, n) => ({ itemId: `it${n}`, entryId }));
    return { ok: true, result: "created", batchId: "b", quantity: i.entryIds.length, extraRequested: i.entryIds.length, liveCount: 0 };
  },
  claimItems: async (_d: unknown, l: { total: number }) => {
    h.claimCalls.push(l.total);
    if (h.claimCalls.length > h.failClaimAfter) return { ok: false, code: "unavailable" };
    const take = h.queue.splice(0, l.total);
    return {
      ok: true,
      items: take.map((t) => ({
        ...t, batchId: "b", studioId: "22222222-2222-4222-8222-222222222222", actorUserId: "a", serviceId: "s",
        startDate: "2026-12-01", endDate: "2026-12-07", allowedWeekdays: null, ttlHours: 48,
      })),
    };
  },
  admitBatchItem: async (_d: unknown, item: { entryId: string }) => (
    h.admitted.push(item.entryId),
    { ok: true, result: "admitted", issued: { invitationId: "i", rawToken: "t", issuedAt: new Date(), expiresAt: new Date(), deliveryEmail: null, deliveryName: null } }
  ),
  settleItem: async (_d: unknown, id: string, o: string) => (h.settled.push(`${id}:${o}`), { ok: true, result: "settled" }),
  replaceInvitation: async () => ({ ok: true, result: "no_live_invitation" }),
}));
// Spacing is the caller's, and is skipped here so 60 items do not take 30 s.
vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as never);

import { continueOverInviteAction, sendOverInviteAction } from "@/app/(app)/settings/waitlist/over-invite/actions";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function form(count: number) {
  const f = new FormData();
  f.append("batchKey", "33333333-3333-4333-8333-333333333333");
  f.append("serviceId", U(900));
  f.append("windowDays", "7");
  f.append("allowedWeekdays", "");
  f.append("shownFit", "0");
  f.append("shownActive", "0");
  f.append("shownExtra", String(count));
  f.append("confirmed", "on");
  for (let i = 1; i <= count; i++) f.append("entryId", U(i));
  return f;
}

beforeEach(() => {
  h.queue = []; h.claimCalls = []; h.admitted = []; h.settled = []; h.failClaimAfter = Infinity;
});

describe("confirmed quantity is processed in full", () => {
  it("60 confirmed recipients are all admitted and settled across chunks, each once", async () => {
    const r = await sendOverInviteAction({ state: "idle" }, form(60));
    expect(r).toMatchObject({ state: "progress", quantity: 60, sent: 60, pending: 0, skipped: 0, failed: 0 });
    expect(h.admitted).toHaveLength(60);
    expect(new Set(h.admitted).size).toBe(60);
    expect(h.settled.filter((s) => s.endsWith(":sent"))).toHaveLength(60);
    // The chunk is 25, so 60 needs at least three claim calls; the chunk never reduced the quantity.
    expect(h.claimCalls.filter((n) => n === 25).length).toBeGreaterThanOrEqual(3);
  });
  it("an outage after the first chunk leaves the remainder visibly pending, never dropped", async () => {
    h.failClaimAfter = 1;
    const r = await sendOverInviteAction({ state: "idle" }, form(60));
    expect(r).toMatchObject({ state: "progress", quantity: 60, sent: 25, pending: 35 });
    expect(h.queue).toHaveLength(35); // still queued in the batch
  });
  it("continuing finishes the same batch with no new confirmation", async () => {
    h.failClaimAfter = 1;
    const first = await sendOverInviteAction({ state: "idle" }, form(60));
    h.failClaimAfter = Infinity;
    const done = await continueOverInviteAction(first);
    expect(done).toMatchObject({ state: "progress", quantity: 60, sent: 60, pending: 0 });
    expect(h.admitted).toHaveLength(60);
  });
});
