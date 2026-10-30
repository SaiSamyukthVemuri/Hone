import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clientCancellationDisabledMessage,
  clientManageDisabledMessage,
  clientManagePageAllowed,
  clientOnlineBookingDisabledMessage,
  clientPortalDisabledMessage,
  clientRescheduleDisabledMessage,
  clientSelfServicePolicyFromStudio,
  DEFAULT_CLIENT_SELF_SERVICE_POLICY,
} from "@/lib/booking/client-self-service-policy";

vi.mock("server-only", () => ({}));

const { loadClientSelfServicePolicy } = await import(
  "@/lib/booking/client-self-service-policy-store"
);

// ===========================================================================
// HON-47 — the one reader of a studio's client self-service policy.
// ===========================================================================

describe("defaults: today's studios keep today's behaviour", () => {
  it("a row with NO policy columns (loaded before 0234 / the HON-47 migration) allows everything", () => {
    expect(clientSelfServicePolicyFromStudio({})).toEqual({
      cancellation: true,
      reschedule: true,
      portal: true,
    });
    expect(clientSelfServicePolicyFromStudio(null)).toEqual(DEFAULT_CLIENT_SELF_SERVICE_POLICY);
    expect(clientSelfServicePolicyFromStudio(undefined)).toEqual(DEFAULT_CLIENT_SELF_SERVICE_POLICY);
  });

  it("NULL is treated as absent (the database default is TRUE, NOT NULL)", () => {
    expect(
      clientSelfServicePolicyFromStudio({
        client_cancellation_enabled: null,
        client_reschedule_enabled: null,
        client_portal_enabled: null,
      }),
    ).toEqual(DEFAULT_CLIENT_SELF_SERVICE_POLICY);
  });

  it("explicit TRUE is the same as absent", () => {
    expect(
      clientSelfServicePolicyFromStudio({
        client_cancellation_enabled: true,
        client_reschedule_enabled: true,
        client_portal_enabled: true,
      }),
    ).toEqual(DEFAULT_CLIENT_SELF_SERVICE_POLICY);
  });
});

describe("each flag is independent, and only FALSE withdraws", () => {
  it.each([
    ["client_cancellation_enabled", { cancellation: false, reschedule: true, portal: true }],
    ["client_reschedule_enabled", { cancellation: true, reschedule: false, portal: true }],
    ["client_portal_enabled", { cancellation: true, reschedule: true, portal: false }],
  ] as const)("%s = false withdraws only its own path", (column, expected) => {
    expect(clientSelfServicePolicyFromStudio({ [column]: false })).toEqual(expected);
  });

  it("a value this code does not understand never grants access", () => {
    for (const odd of ["true", "false", 1, 0, {}, []]) {
      expect(clientSelfServicePolicyFromStudio({ client_portal_enabled: odd }).portal).toBe(false);
    }
  });

  it("never reads new_client_admission_mode", () => {
    for (const mode of ["open", "waitlist", "closed", undefined]) {
      expect(
        clientSelfServicePolicyFromStudio({ new_client_admission_mode: mode } as Record<string, unknown>),
      ).toEqual(DEFAULT_CLIENT_SELF_SERVICE_POLICY);
    }
    const source = readFileSync(
      path.resolve(__dirname, "../../../lib/booking/client-self-service-policy.ts"),
      "utf8",
    ).replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/new_client_admission_mode\s*[,)}\]]|\.new_client_admission_mode/);
  });
});

describe("/manage is offered while ANY self-service path is", () => {
  it.each([
    [true, true, true, true],
    [false, true, true, true],
    [true, false, true, true],
    [true, true, false, true],
    [false, false, true, true],
    [false, true, false, true],
    [true, false, false, true],
    [false, false, false, false],
  ])("cancel=%s reschedule=%s portal=%s -> %s", (cancellation, reschedule, portal, allowed) => {
    expect(clientManagePageAllowed({ cancellation, reschedule, portal })).toBe(allowed);
  });
});

describe("refusal copy is understandable and says what still holds", () => {
  it("names the studio when known, and falls back to 'the studio'", () => {
    for (const fn of [
      clientCancellationDisabledMessage,
      clientRescheduleDisabledMessage,
      clientManageDisabledMessage,
      clientPortalDisabledMessage,
      clientOnlineBookingDisabledMessage,
    ]) {
      expect(fn("Synthetic Studio")).toContain("Synthetic Studio");
      expect(fn(null)).toContain("the studio");
      expect(fn("   ")).toContain("the studio");
      expect(fn("Synthetic Studio")).toMatch(/contact/i);
    }
  });

  it("cancel and reschedule refusals say the appointment is still booked", () => {
    expect(clientCancellationDisabledMessage(null)).toMatch(/still booked/);
    expect(clientRescheduleDisabledMessage(null)).toMatch(/still booked/);
  });

  it("the booking refusal never says 'returning' or 'existing' (no client enumeration)", () => {
    expect(clientOnlineBookingDisabledMessage("Synthetic Studio")).not.toMatch(/returning|existing|on file/i);
  });
});

describe("the server loader", () => {
  function reader(result: { data: Record<string, unknown> | null; error: { code?: string } | null }) {
    const calls: Array<{ table: string; columns: string; id: string }> = [];
    const admin = {
      from(table: string) {
        return {
          select(columns: string) {
            return {
              eq(_c: string, id: string) {
                calls.push({ table, columns, id });
                return { maybeSingle: async () => result };
              },
            };
          },
        };
      },
    };
    return { admin, calls };
  }

  it("reads the studio with select('*'), so absent columns are absent keys, not a 42703", async () => {
    const { admin, calls } = reader({ data: { id: "s1", name: "Synthetic Studio" }, error: null });
    const r = await loadClientSelfServicePolicy(admin, "s1");
    expect(calls).toEqual([{ table: "studios", columns: "*", id: "s1" }]);
    expect(r).toEqual({ ok: true, policy: DEFAULT_CLIENT_SELF_SERVICE_POLICY, studioName: "Synthetic Studio" });
  });

  it("returns the persisted choice", async () => {
    const { admin } = reader({
      data: { id: "s1", name: "Synthetic Studio", client_portal_enabled: false, client_cancellation_enabled: false },
      error: null,
    });
    const r = await loadClientSelfServicePolicy(admin, "s1");
    expect(r.ok && r.policy).toEqual({ cancellation: false, reschedule: true, portal: false });
  });

  it("FAILS CLOSED on a read error, a missing row, or a missing studio id", async () => {
    const silence = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await loadClientSelfServicePolicy(reader({ data: null, error: { code: "57014" } }).admin, "s1")).toEqual({ ok: false });
    expect(await loadClientSelfServicePolicy(reader({ data: null, error: null }).admin, "s1")).toEqual({ ok: false });
    expect(await loadClientSelfServicePolicy(reader({ data: { id: "s1" }, error: null }).admin, null)).toEqual({ ok: false });
    silence.mockRestore();
  });
});
