import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RELEASABLE_ERROR_CODES, senderRecoveryFor } from "@/lib/sms/sender-controls";
import { RECOVERY_ROUTE_BY_ERROR_CODE } from "@/lib/sms/sender-status";

// Codex P2 4271461595: the recovery an errored setup offers comes from its
// stored code, and the release list is EXACTLY what 0226's command accepts.

describe("senderRecoveryFor", () => {
  it("the release codes are 0226's, byte for byte", () => {
    const sql = readFileSync("supabase/migrations/0226_studio_sms_sender_unpurchased_release.sql", "utf8");
    const lists = [...sql.matchAll(/not in \(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const list of lists) expect([...list].sort()).toEqual([...RELEASABLE_ERROR_CODES].sort());
  });

  it("release codes release; retry-routed codes retry; everything else offers nothing", () => {
    for (const code of RELEASABLE_ERROR_CODES) expect(senderRecoveryFor("error", code), code).toBe("release");
    for (const [code, route] of Object.entries(RECOVERY_ROUTE_BY_ERROR_CODE)) {
      if ((RELEASABLE_ERROR_CODES as readonly string[]).includes(code)) continue;
      expect(senderRecoveryFor("error", code), code).toBe(route === "retry" ? "retry" : "none");
    }
    expect(senderRecoveryFor("error", "provider_unavailable")).toBe("retry");
    expect(senderRecoveryFor("error", "finalize_failed")).toBe("retry");
    expect(senderRecoveryFor("error", "provider_rejected")).toBe("none");
    expect(senderRecoveryFor("error", "something_new")).toBe("none");
    expect(senderRecoveryFor("error", null)).toBe("none");
  });

  it("only an errored setup offers anything", () => {
    for (const status of ["off", "selecting", "provisioning", "active", "suspended", "releasing", "released", null, undefined]) {
      expect(senderRecoveryFor(status, "provider_unavailable"), String(status)).toBe("none");
    }
  });
});

describe("the page and the action derive it on the server (source guard)", () => {
  const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  it("the page passes senderRecoveryFor(status, last_error_code); the retry action reads no form field", () => {
    const page = strip(readFileSync("app/(app)/settings/integrations/page.tsx", "utf8"));
    expect(page).toMatch(/recovery=\{senderRecoveryFor\(sender\?\.status, sender\?\.last_error_code\)\}/);
    const actions = strip(readFileSync("app/(app)/settings/integrations/sender-control-actions.ts", "utf8"));
    const retry = actions.slice(actions.indexOf("export async function retrySenderClaimAction("));
    const body = retry.slice(0, retry.indexOf("\n}\n"));
    expect(body).toMatch(/_formData: FormData/);
    expect(body).not.toMatch(/formData\.get|str\(/);
    expect(body).toMatch(/const ctx = await ownerContext\(\);\s*\n\s*if \(!ctx\.ok\)/);
  });
});
