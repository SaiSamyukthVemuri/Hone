import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RELEASABLE_ERROR_CODES, senderRecoveryFor } from "@/lib/sms/sender-controls";
import { RECOVERY_ROUTE_BY_ERROR_CODE } from "@/lib/sms/sender-status";

// Codex P2 4271461595: the recovery an errored setup offers comes from its
// stored code, and the release list is EXACTLY what 0226's command accepts.

describe("senderRecoveryFor: the routing table, every row at once", () => {
  it("the release codes are 0226's, byte for byte", () => {
    const sql = readFileSync("supabase/migrations/0226_studio_sms_sender_unpurchased_release.sql", "utf8");
    const lists = [...sql.matchAll(/not in \(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const list of lists) expect([...list].sort()).toEqual([...RELEASABLE_ERROR_CODES].sort());
  });

  // /srv/hone/handoffs/SMS_863_RECOVERY_ROUTING_TABLE_2026-10-14.md, as code.
  const expected = (code: string | null, identifiersRecorded: boolean) => {
    if (code && (RELEASABLE_ERROR_CODES as readonly string[]).includes(code)) return "release";
    if (code && RECOVERY_ROUTE_BY_ERROR_CODE[code] === "retry" && !identifiersRecorded) return "retry";
    return "support";
  };
  const codes: Array<string | null> = [...Object.keys(RECOVERY_ROUTE_BY_ERROR_CODE), "provider_test_sender_mismatch", "something_new", null];

  it("in error: every known code, an unknown code and none, with and without recorded identifiers", () => {
    for (const code of codes) {
      for (const recorded of [false, true]) {
        expect(senderRecoveryFor("error", code, recorded), `${code} recorded=${recorded}`).toBe(expected(code, recorded));
      }
    }
  });

  it("the rows that matter, spelled out", () => {
    // Bought or partly configured, nothing recorded: the reconcile retry.
    expect(senderRecoveryFor("error", "provider_unavailable", false)).toBe("retry");
    expect(senderRecoveryFor("error", "finalize_failed", false)).toBe("retry");
    // Identifiers recorded (adopted, or finalized then the test failed):
    // origin unknown, so no retry is offered (Codex P2 4271749292).
    expect(senderRecoveryFor("error", "provider_unavailable", true)).toBe("support");
    expect(senderRecoveryFor("error", "finalize_failed", true)).toBe("support");
    // Definitive pre-purchase: release, recorded or not (0226 itself refuses recorded rows).
    expect(senderRecoveryFor("error", "number_no_longer_available", false)).toBe("release");
    expect(senderRecoveryFor("error", "provider_resource_mismatch", false)).toBe("release");
    // Support-only and unknown codes.
    expect(senderRecoveryFor("error", "provider_rejected", false)).toBe("support");
    expect(senderRecoveryFor("error", "something_new", false)).toBe("support");
    expect(senderRecoveryFor("error", null, false)).toBe("support");
  });

  it("only an errored setup offers anything", () => {
    for (const status of ["off", "selecting", "provisioning", "active", "suspended", "releasing", "released", null, undefined]) {
      for (const code of codes) {
        for (const recorded of [false, true]) expect(senderRecoveryFor(status, code, recorded), `${status} ${code}`).toBe("none");
      }
    }
  });
});

describe("the page and the action derive it on the server (source guard)", () => {
  const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  it("the page passes senderRecoveryFor(status, last_error_code); the retry action reads no form field", () => {
    const page = strip(readFileSync("app/(app)/settings/integrations/page.tsx", "utf8"));
    expect(page).toMatch(/recovery=\{senderRecoveryFor\(sender\?\.status, sender\?\.last_error_code, Boolean\(sender\?\.phone_number\)\)\}/);
    const actions = strip(readFileSync("app/(app)/settings/integrations/sender-control-actions.ts", "utf8"));
    const retry = actions.slice(actions.indexOf("export async function retrySenderClaimAction("));
    const body = retry.slice(0, retry.indexOf("\n}\n"));
    expect(body).toMatch(/_formData: FormData/);
    expect(body).not.toMatch(/formData\.get|str\(/);
    expect(body).toMatch(/const ctx = await ownerContext\(\);\s*\n\s*if \(!ctx\.ok\)/);
  });
});
