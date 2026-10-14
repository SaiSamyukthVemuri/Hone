import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RELEASABLE_ERROR_CODES, senderRecoveryFor } from "@/lib/sms/sender-controls";
import { RECOVERY_ROUTE_BY_ERROR_CODE } from "@/lib/sms/sender-status";

// Codex P2 4271461595, 4271749292, 4272070468: an errored setup offers only
// what is honest without its origin, which is not stored. The routing table is
// /srv/hone/handoffs/SMS_863_RECOVERY_ROUTING_TABLE_2026-10-14.md.

describe("senderRecoveryFor: the routing table, every row at once", () => {
  it("the release codes are 0226's, byte for byte", () => {
    const sql = readFileSync("supabase/migrations/0226_studio_sms_sender_unpurchased_release.sql", "utf8");
    const lists = [...sql.matchAll(/not in \(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const list of lists) expect([...list].sort()).toEqual([...RELEASABLE_ERROR_CODES].sort());
  });

  const codes: Array<string | null> = [...Object.keys(RECOVERY_ROUTE_BY_ERROR_CODE), "provider_test_sender_mismatch", "something_new", null];

  it("in error: release for 0226's codes, support for every other code (retry-routed ones included), unknown and none", () => {
    for (const code of codes) {
      const expected = code && (RELEASABLE_ERROR_CODES as readonly string[]).includes(code) ? "release" : "support";
      expect(senderRecoveryFor("error", code), String(code)).toBe(expected);
    }
    // The retry-routed codes are support until the origin is known (the follow-up).
    for (const code of ["provider_unavailable", "provider_timeout", "finalize_failed", "lease_lost"]) {
      expect(senderRecoveryFor("error", code), code).toBe("support");
    }
  });

  it("only an errored setup offers anything", () => {
    for (const status of ["off", "selecting", "provisioning", "active", "suspended", "releasing", "released", null, undefined]) {
      for (const code of codes) expect(senderRecoveryFor(status, code), `${status} ${code}`).toBe("none");
    }
  });
});

describe("no retry surface in this slice (source guard)", () => {
  const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  it("the page derives the action from status and code; no retry action, button or orchestration exists", () => {
    const page = strip(readFileSync("app/(app)/settings/integrations/page.tsx", "utf8"));
    expect(page).toMatch(/recovery=\{senderRecoveryFor\(sender\?\.status, sender\?\.last_error_code\)\}/);
    const actions = readFileSync("app/(app)/settings/integrations/sender-control-actions.ts", "utf8");
    const controls = readFileSync("app/(app)/settings/integrations/SmsSenderControls.tsx", "utf8");
    const lib = readFileSync("lib/sms/sender-controls.ts", "utf8");
    expect(actions).not.toMatch(/retrySenderClaimAction|runSenderRetry/);
    expect(controls).not.toMatch(/retrySenderClaimAction|Retry setup/);
    expect(lib).not.toMatch(/export async function runSenderRetry/);
    expect(controls).toMatch(/recovery === "support"/);
    expect(controls).toMatch(/recovery === "release"/);
  });
});
