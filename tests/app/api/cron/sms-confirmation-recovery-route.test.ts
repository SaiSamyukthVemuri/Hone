import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// D5 (#824): the recovery route is inert unless switched on, and is on no
// scheduler. Disabled, it must answer without creating a database client.

const h = { adminCreated: 0, runs: 0 };

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    h.adminCreated += 1;
    return {};
  },
}));
vi.mock("@/lib/sms/confirmation-recovery", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sms/confirmation-recovery")>();
  return {
    ...real,
    recoverOwedConfirmations: async () => {
      h.runs += 1;
      return { ran: true, considered: 0, sent: 0, failed: 0, skipped: {} };
    },
  };
});

const { GET } = await import("@/app/api/cron/sms-confirmation-recovery/route");
import { readFileSync } from "node:fs";

const KEYS = ["CRON_SECRET", "SMS_CONFIRMATION_RECOVERY", "NEXT_PUBLIC_APP_URL", "APP_ORIGIN"] as const;
const saved: Record<string, string | undefined> = {};
const req = (auth?: string) =>
  new Request("https://app.example/api/cron/sms-confirmation-recovery", {
    headers: auth ? { authorization: auth } : {},
  });

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.CRON_SECRET = "s3cret";
  delete process.env.SMS_CONFIRMATION_RECOVERY;
  h.adminCreated = 0;
  h.runs = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("sms-confirmation-recovery route", () => {
  it("refuses an unauthorized request before anything else", async () => {
    process.env.SMS_CONFIRMATION_RECOVERY = "on";
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer wrong"))).status).toBe(401);
    expect(h.adminCreated + h.runs).toBe(0);
  });

  it("disabled (the default): answers ran:false without creating a database client", async () => {
    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ran: false, reason: "disabled" });
    expect(h.adminCreated + h.runs).toBe(0);
  });

  it("is on no Vercel schedule (activation is a separate, approved scheduler step)", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons?: Array<{ path: string }> };
    expect((vercel.crons ?? []).map((c) => c.path)).not.toContain("/api/cron/sms-confirmation-recovery");
  });
});
