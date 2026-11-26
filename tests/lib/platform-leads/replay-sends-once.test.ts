import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdempotentEmailTransport } from "@/lib/email/new-client-waitlist-send";
import { fakeLeadAlertDb } from "./helpers/fake-transports";

// HON-84. One operator alert per lead event, however it is replayed, raced or reordered. The recipient is a FAKE
// transport: nothing here can reach a real inbox, and the recipient has no default (alert-config).
//
// What makes a send happen exactly once, as the 0213 contract has it (fake-transports.ts models it in memory):
//   * the alert row is the dedupe unit: one row per saved lead, claimed under a fresh fence token;
//   * a settled (accepted) alert is never claimable again;
//   * every attempt of one alert goes out under that alert's own idempotency key.

vi.mock("next/server", () => ({ after: (task: unknown) => void task }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => undefined }));

import { deliverPlatformLeadAlert, recipientKey, sweepPlatformLeadAlerts } from "@/lib/platform-leads/alert-delivery";

const OPS = "ops@hone.example";
const ENV = { LEAD_ALERT_RECIPIENTS: OPS, ADMIN_EMAILS: OPS };
const A = "8f0c2b7e-5d1a-4a2b-9c3d-4e5f6a7b8c9d";
const B = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";

type Sent = { to: unknown; key: string | undefined };

function countingTransport(sent: Sent[]): IdempotentEmailTransport {
  let n = 0;
  return {
    emails: {
      send: async (payload, options) => {
        sent.push({ to: (payload as { to?: unknown }).to, key: options?.idempotencyKey });
        n += 1;
        return { data: { id: `msg-${n}` }, error: null } as never;
      },
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const deps = (db: ReturnType<typeof fakeLeadAlertDb>, sent: Sent[]) => ({
  admin: db.client,
  transport: countingTransport(sent),
  env: ENV,
  appOrigin: () => "https://hone.example",
});

describe("a replayed lead event sends one alert", () => {
  it("the same alert delivered twice in a row: one send, the second finds nothing to claim", async () => {
    const db = fakeLeadAlertDb();
    db.add(A);
    const sent: Sent[] = [];
    expect(await deliverPlatformLeadAlert(A, deps(db, sent))).toEqual({ result: "accepted" });
    const again = await deliverPlatformLeadAlert(A, deps(db, sent));
    expect(again).not.toEqual({ result: "accepted" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ to: OPS, key: recipientKey(`lead-alert/${A}/1`, OPS) });
    expect(db.alert(A).status).toBe("accepted");
  });

  it("the same alert raced by two workers (schedule and sweep): one send", async () => {
    const db = fakeLeadAlertDb();
    db.add(A);
    const sent: Sent[] = [];
    const [x, y] = await Promise.all([deliverPlatformLeadAlert(A, deps(db, sent)), deliverPlatformLeadAlert(A, deps(db, sent))]);
    expect(sent).toHaveLength(1);
    expect([x, y].filter((r) => r.result === "accepted")).toHaveLength(1);
  });

  it("a sweep after the direct delivery sends nothing more", async () => {
    const db = fakeLeadAlertDb();
    db.add(A);
    const sent: Sent[] = [];
    await deliverPlatformLeadAlert(A, deps(db, sent));
    await sweepPlatformLeadAlerts(deps(db, sent));
    expect(sent).toHaveLength(1);
  });
});

describe("two lead events arriving reordered", () => {
  it("delivering B before A, then sweeping twice: each alert sent once, each under its own key", async () => {
    const db = fakeLeadAlertDb();
    db.add(A);
    db.add(B);
    const sent: Sent[] = [];
    // B's request finishes first, although A was saved first: the worker leases whichever is due, so the keys, not the order, identify the sends.
    await deliverPlatformLeadAlert(B, deps(db, sent));
    await sweepPlatformLeadAlerts(deps(db, sent));
    await sweepPlatformLeadAlerts(deps(db, sent));
    expect(sent.map((s) => s.key).sort()).toEqual([recipientKey(`lead-alert/${A}/1`, OPS), recipientKey(`lead-alert/${B}/1`, OPS)].sort());
    expect(new Set(sent.map((s) => s.key)).size).toBe(2);
    expect(db.alert(A).status).toBe("accepted");
    expect(db.alert(B).status).toBe("accepted");
  });

  it("a duplicate delivery of A arriving after B has been sent still sends A once", async () => {
    const db = fakeLeadAlertDb();
    db.add(A);
    db.add(B);
    const sent: Sent[] = [];
    await Promise.all([
      deliverPlatformLeadAlert(B, deps(db, sent)),
      deliverPlatformLeadAlert(A, deps(db, sent)),
      deliverPlatformLeadAlert(A, deps(db, sent)),
      deliverPlatformLeadAlert(B, deps(db, sent)),
    ]);
    await sweepPlatformLeadAlerts(deps(db, sent));
    const keys = sent.map((s) => s.key);
    expect(keys.filter((k) => k === recipientKey(`lead-alert/${A}/1`, OPS))).toHaveLength(1);
    expect(keys.filter((k) => k === recipientKey(`lead-alert/${B}/1`, OPS))).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });

  it("with no recipient configured nothing is sent, and the alert stays pending for when one is", async () => {
    const db = fakeLeadAlertDb();
    db.add(A);
    const sent: Sent[] = [];
    // recipient_not_configured: the blocker is recorded through a command the fake does not model, so the worker answers blocked or threw, never accepted
    const out = await deliverPlatformLeadAlert(A, { ...deps(db, sent), env: {} });
    expect(out.result).not.toBe("accepted");
    expect(sent).toHaveLength(0);
    expect(db.alert(A).status).toBe("pending");
  });
});
