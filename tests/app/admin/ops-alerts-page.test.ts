import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #193. Pins the admin ops-alerts dashboard: admin-only access,
// unresolved-first ordering with critical on top, safe metadata
// rendering, and the conditional mark-resolved action.

const ROOT = path.resolve(__dirname, "../../..");
const PAGE = readFileSync(
  path.join(ROOT, "app/admin/ops-alerts/page.tsx"),
  "utf8",
);
const ACTIONS = readFileSync(
  path.join(ROOT, "app/admin/ops-alerts/actions.ts"),
  "utf8",
);
const LAYOUT = readFileSync(path.join(ROOT, "app/admin/layout.tsx"), "utf8");

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const ACTIONS_CODE = codeOnly(ACTIONS);

describe("admin-only access", () => {
  it("the admin layout guards every /admin route including ops-alerts", () => {
    expect(LAYOUT).toMatch(/if \(!user\) redirect\("\/login"\);/);
    expect(LAYOUT).toMatch(/if \(!isAdmin\(user\.email\)\) redirect\("\/dashboard"\);/);
    expect(LAYOUT).toMatch(/href="\/admin\/ops-alerts"/);
  });

  it("the resolve action re-checks isAdmin server-side (non-admin refused)", () => {
    expect(ACTIONS_CODE).toMatch(
      /if \(!user \|\| !isAdmin\(user\.email\)\) \{\s*\n?\s*throw new Error\("Unauthorized\."\);/,
    );
  });
});

describe("unresolved alerts rendering", () => {
  it("fetches unresolved first (resolved_at IS NULL) plus a recent resolved list", () => {
    expect(PAGE).toMatch(/\.is\("resolved_at", null\)/);
    expect(PAGE).toMatch(/\.not\("resolved_at", "is", null\)/);
  });

  it("orders critical > warning > info, newest first within severity", () => {
    expect(PAGE).toMatch(/critical: 0,\s*\n?\s*warning: 1,\s*\n?\s*info: 2,/);
    expect(PAGE).toMatch(
      /\.order\("created_at", \{ ascending: false \}\)/,
    );
    expect(PAGE).toMatch(
      /SEVERITY_ORDER\[a\.severity\] - SEVERITY_ORDER\[b\.severity\]/,
    );
  });

  it("renders severity, event, created time, message, ids, and a details expander", () => {
    for (const pin of [
      "severityBadge(alert.severity)",
      "{alert.event}",
      "{alert.message}",
      "idLines(alert)",
      "Details (redacted at write time)",
      "JSON.stringify(alert.safe_details, null, 2)",
    ]) {
      expect(PAGE).toContain(pin);
    }
  });

  it("safe metadata only: page renders columns + safe_details (redacted at write), nothing clinical or card-shaped", () => {
    expect(PAGE).not.toMatch(/allergies|intake|skin_notes|session_notes/);
    expect(PAGE).not.toMatch(/card_number|cvc|last4|client_secret/);
    // Reads use the service-role client because NULL-studio alerts
    // are operator-only by design.
    expect(PAGE).toMatch(/createAdminClient/);
  });
});

describe("mark resolved", () => {
  it("conditional UPDATE only when still unresolved", () => {
    expect(ACTIONS_CODE).toMatch(
      /\.update\(\{\s*\n?\s*resolved_at: new Date\(\)\.toISOString\(\),\s*\n?\s*resolved_by_practitioner_id: practitionerRow\?\.id \?\? null,\s*\n?\s*resolution_note: note,\s*\n?\s*\}\)\s*\n?\s*\.eq\("id", alertId\)\s*\n?\s*\.is\("resolved_at", null\)/,
    );
  });

  it("resolution note is optional and length-capped to the DB CHECK", () => {
    expect(ACTIONS_CODE).toMatch(/\.slice\(0, 2000\)/);
  });

  it("revalidates the dashboard after resolving", () => {
    expect(ACTIONS_CODE).toMatch(/revalidatePath\("\/admin\/ops-alerts"\)/);
  });
});

describe("PR #195: app-path smoke action", () => {
  it("the test-alert action re-checks isAdmin and calls the REAL recordOpsAlert", () => {
    const body = ACTIONS_CODE.slice(
      ACTIONS_CODE.indexOf("export async function sendTestCriticalAlertAction"),
      ACTIONS_CODE.indexOf("export async function resolveOpsAlertAction"),
    );
    expect(body).toMatch(/if \(!user \|\| !isAdmin\(user\.email\)\)/);
    expect(body).toMatch(/await recordOpsAlert\(\{/);
    expect(ACTIONS).toMatch(/import \{ recordOpsAlert \} from "@\/lib\/ops\/alerts"/);
  });

  it("the payload is exactly the agreed smoke shape", () => {
    expect(ACTIONS_CODE).toMatch(/severity: "critical",/);
    expect(ACTIONS_CODE).toMatch(/event: "smoke_test_critical_alert_app_path",/);
    expect(ACTIONS_CODE).toMatch(
      /message: "PR #195 app-path smoke test critical alert",/,
    );
    expect(ACTIONS_CODE).toMatch(
      /safeDetails: \{\s*\n?\s*smoke: true,\s*\n?\s*pr: 195,\s*\n?\s*path: "app",\s*\n?\s*\}/,
    );
  });

  it("the button renders on the admin page bound to the action", () => {
    expect(PAGE).toMatch(/action=\{sendTestCriticalAlertAction\}/);
    expect(PAGE).toMatch(/Send test critical alert/);
  });

  it("the smoke touches no Stripe/payment/client surface", () => {
    expect(ACTIONS_CODE).not.toMatch(
      /paymentIntents|stripe|charge|client_payment|clients\b/i,
    );
  });
});

describe("PR #193 boundaries", () => {
  it("no payment/Stripe runtime surface", () => {
    const all = PAGE + ACTIONS_CODE;
    expect(all).not.toMatch(
      /paymentIntents|refunds\.create|charges\.create|checkout\.sessions|STRIPE_ALLOW_LIVE_MODE|getStripe/,
    );
  });

  it("no public access: route lives under the guarded /admin tree", () => {
    expect(PAGE).not.toMatch(/export const runtime/);
    expect(ACTIONS).toMatch(/"use server"/);
  });
});
