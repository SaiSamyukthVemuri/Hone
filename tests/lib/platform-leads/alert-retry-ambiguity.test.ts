import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LEAD_ALERT_ERROR_CODES, LEAD_ALERT_KNOWN_UNSENT_CODES, leadAlertMayHaveBeenSent } from "@/lib/platform-leads/alert-status";

// Codex P2 4276616247: which failed alerts may already have been sent.

describe("leadAlertMayHaveBeenSent", () => {
  it("every error code, with and without attempts", () => {
    for (const code of [...LEAD_ALERT_ERROR_CODES, null, "unknown_new_code"]) {
      for (const attempts of [0, 1, 5]) {
        const knownUnsent = (code !== null && (LEAD_ALERT_KNOWN_UNSENT_CODES as readonly string[]).includes(code)) || (code === "expired" && attempts === 0);
        expect(leadAlertMayHaveBeenSent(code, attempts), `${code} ${attempts}`).toBe(!knownUnsent);
      }
    }
  });

  it("the known-unsent codes are real error codes", () => {
    for (const code of LEAD_ALERT_KNOWN_UNSENT_CODES) expect(LEAD_ALERT_ERROR_CODES as readonly string[]).toContain(code);
  });

  it("the action passes the form's confirmation through, and only an explicit 'yes' counts", () => {
    const src = readFileSync("app/admin/actions.ts", "utf8");
    expect(src).toMatch(/p_confirm_possible_duplicate: formData\.get\("confirm_possible_duplicate"\) === "yes",/);
  });
});
