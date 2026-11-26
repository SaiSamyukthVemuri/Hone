import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdempotentEmailTransport } from "@/lib/email/new-client-waitlist-send";
import { fakeLeadAlertDb } from "./helpers/fake-transports";

// Several recipients, one email each. FAKE transport and FAKE addresses only: the real list is server config set at release.
//
// How a replay never mails anyone twice without a migration: every recipient has its OWN idempotency key (the alert's key x the
// recipient). A retry of the alert re-presents every key, and the provider answers an already-accepted key with its original result
// instead of sending again. The fake provider below behaves exactly so: a repeated key is a replay, not a new delivery.

vi.mock("next/server", () => ({ after: (task: unknown) => void task }));
const ops = vi.hoisted(() => ({ calls: [] as Array<{ event: string; safeDetails?: Record<string, unknown>; message?: string }> }));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (i: { event: string; safeDetails?: Record<string, unknown>; message?: string }) => void ops.calls.push(i),
}));

import { combineSettlements, deliverPlatformLeadAlert, recipientKey, sweepPlatformLeadAlerts } from "@/lib/platform-leads/alert-delivery";

const R1 = "one@hone.example";
const R2 = "two@hone.example";
const R3 = "three@hone.example";
const A = "8f0c2b7e-5d1a-4a2b-9c3d-4e5f6a7b8c9d";
const ENV = { LEAD_ALERT_RECIPIENTS: `${R1},${R2},${R3}` };

type Behaviour = (to: string, attempt: number) => "accept" | "reject" | "unavailable";

/** A provider with key memory: a key it has accepted before is replayed, never delivered again. */
function fakeProvider(behaviour: Behaviour = () => "accept") {
  const delivered = new Map<string, string>(); // key -> recipient
  const requests: Array<{ to: string; key: string | undefined }> = [];
  const attempts = new Map<string, number>();
  const transport: IdempotentEmailTransport = {
    emails: {
      send: async (payload, options) => {
        const to = String((payload as { to: unknown }).to);
        const key = options?.idempotencyKey;
        requests.push({ to, key });
        if (key && delivered.has(key)) return { data: { id: `msg-${key}` }, error: null } as never; // replay
        const n = (attempts.get(to) ?? 0) + 1;
        attempts.set(to, n);
        const how = behaviour(to, n);
        if (how === "reject") return { data: null, error: { name: "validation_error", message: "rejected" } } as never;
        if (how === "unavailable") return { data: null, error: { name: "application_error", message: "try later", statusCode: 503 } } as never;
        if (key) delivered.set(key, to);
        return { data: { id: `msg-${key}` }, error: null } as never;
      },
    },
  };
  return { transport, delivered, requests };
}

const deps = (db: ReturnType<typeof fakeLeadAlertDb>, p: ReturnType<typeof fakeProvider>, env: Record<string, string> = ENV) => ({
  admin: db.client,
  transport: p.transport,
  env,
  appOrigin: () => "https://hone.example",
});

beforeEach(() => {
  ops.calls.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("three recipients", () => {
  it("each gets exactly one email, under its own key, and the alert is accepted", async () => {
    const db = fakeLeadAlertDb();
    db.add(A);
    const p = fakeProvider();
    expect(await deliverPlatformLeadAlert(A, deps(db, p))).toEqual({ result: "accepted" });
    expect(p.requests.map((r) => r.to).sort()).toEqual([R1, R2, R3].sort());
    expect(p.delivered.size).toBe(3);
    expect(new Set(p.requests.map((r) => r.key)).size).toBe(3);
    for (const r of [R1, R2, R3]) expect(p.delivered.get(recipientKey(`lead-alert/${A}/1`, r))).toBe(r);
    expect(db.alert(A).status).toBe("accepted");
  });

  it("a recipient is not tied to the admin allowlist: none of them is on ADMIN_EMAILS and all are mailed", async () => {
    const db = fakeLeadAlertDb();
    db.add(A);
    const p = fakeProvider();
    await deliverPlatformLeadAlert(A, deps(db, p, { ...ENV, ADMIN_EMAILS: "someone-else@hone.example" }));
    expect(p.delivered.size).toBe(3);
  });

  it("the keys do not depend on the list's order", () => {
    expect(recipientKey("lead-alert/x/1", R1)).toBe(recipientKey("lead-alert/x/1", R1.toUpperCase().toLowerCase()));
    expect(recipientKey("lead-alert/x/1", R1)).not.toBe(recipientKey("lead-alert/x/1", R2));
    expect(recipientKey("lead-alert/x/1", R1)).not.toBe(recipientKey("lead-alert/x/2", R1));
  });
});

describe("a replay sends nothing new", () => {
  it("delivering the settled alert again, and sweeping, makes no request at all", async () => {
    const db = fakeLeadAlertDb();
    db.add(A);
    const p = fakeProvider();
    await deliverPlatformLeadAlert(A, deps(db, p));
    const before = p.requests.length;
    await deliverPlatformLeadAlert(A, deps(db, p));
    await sweepPlatformLeadAlerts(deps(db, p));
    expect(p.requests).toHaveLength(before);
    expect(p.delivered.size).toBe(3);
  });

  it("two workers racing on one alert deliver to each recipient once", async () => {
    const db = fakeLeadAlertDb();
    db.add(A);
    const p = fakeProvider();
    await Promise.all([deliverPlatformLeadAlert(A, deps(db, p)), deliverPlatformLeadAlert(A, deps(db, p))]);
    expect(p.delivered.size).toBe(3);
    expect(p.requests).toHaveLength(3);
  });
});

describe("one recipient failing does not block the others", () => {
  it("a retryable failure for R2: R1 and R3 are mailed now, the alert retries, and the retry mails ONLY R2 (the others replay)", async () => {
    const db = fakeLeadAlertDb();
    db.add(A);
    const p = fakeProvider((to, attempt) => (to === R2 && attempt === 1 ? "unavailable" : "accept"));
    expect(await deliverPlatformLeadAlert(A, deps(db, p))).toEqual({ result: "retry_scheduled" });
    expect(p.delivered.size).toBe(2);
    expect([...p.delivered.values()].sort()).toEqual([R1, R3].sort());
    expect(db.alert(A).status).toBe("pending");

    db.alert(A).nextAttemptAt = 0;
    await sweepPlatformLeadAlerts(deps(db, p));
    expect(p.delivered.size).toBe(3);
    // nobody was mailed twice: R1 and R3 were presented again under their keys and replayed, so exactly three distinct deliveries exist
    expect([...p.delivered.values()].sort()).toEqual([R1, R2, R3].sort());
    expect(db.alert(A).status).toBe("accepted");
  });

  it("a final refusal for R2: the other two are mailed, the alert is accepted, and the failure is recorded without any address", async () => {
    const db = fakeLeadAlertDb();
    db.add(A);
    const p = fakeProvider((to) => (to === R2 ? "reject" : "accept"));
    expect(await deliverPlatformLeadAlert(A, deps(db, p))).toEqual({ result: "accepted" });
    expect([...p.delivered.values()].sort()).toEqual([R1, R3].sort());
    const rec = ops.calls.find((c) => c.event === "platform_lead_alert_recipient_failed");
    expect(rec?.safeDetails).toMatchObject({ alert_id: A, accepted: 2, failed: 1, code: "provider_rejected" });
    expect(JSON.stringify(rec)).not.toMatch(/hone\.example/);
  });

  it("every recipient refused: the alert fails, and no recipient-failed warning is raised for an alert nobody received", async () => {
    const db = fakeLeadAlertDb();
    db.add(A);
    const p = fakeProvider(() => "reject");
    expect(await deliverPlatformLeadAlert(A, deps(db, p))).toEqual({ result: "failed" });
    expect(p.delivered.size).toBe(0);
    expect(ops.calls.some((c) => c.event === "platform_lead_alert_recipient_failed")).toBe(false);
  });
});

describe("combineSettlements", () => {
  const ok = { outcome: "accepted", messageId: "m" } as const;
  const retry = { outcome: "retry", errorCode: "provider_unavailable" } as const;
  const fail = { outcome: "fail", errorCode: "provider_rejected" } as const;
  it("all accepted: accepted; any retry: retry; a refusal beside an acceptance: accepted; only refusals: fail", () => {
    expect(combineSettlements([ok, ok]).settlement.outcome).toBe("accepted");
    expect(combineSettlements([ok, retry, fail]).settlement.outcome).toBe("retry");
    expect(combineSettlements([ok, fail]).settlement.outcome).toBe("accepted");
    expect(combineSettlements([fail, fail]).settlement.outcome).toBe("fail");
    expect(combineSettlements([ok, fail]).failedCount).toBe(1);
  });
});

describe("an invalid list entry is refused at config: nothing is sent", () => {
  it("one bad entry blocks the whole alert and mails nobody", async () => {
    const db = fakeLeadAlertDb();
    db.add(A);
    const p = fakeProvider();
    const out = await deliverPlatformLeadAlert(A, deps(db, p, { LEAD_ALERT_RECIPIENTS: `${R1},not an address,${R3}` }));
    expect(out.result).toBe("blocked");
    expect(p.requests).toHaveLength(0);
    expect(db.alert(A).status).toBe("pending");
  });
});
