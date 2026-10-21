import { beforeEach, describe, expect, it, vi } from "vitest";
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
    // The conditional shape is unchanged by 0178; only the attribution SOURCE
    // moved, from `practitionerRow?.id ?? null` (which let `.maybeSingle()`'s
    // error decide attribution for a multi-membership admin) to an explicit
    // plurality rule.
    expect(ACTIONS_CODE).toMatch(
      /\.update\(\{\s*\n?\s*resolved_at: new Date\(\)\.toISOString\(\),\s*\n?\s*resolved_by_practitioner_id: practitionerId,\s*\n?\s*resolution_note: note,\s*\n?\s*\}\)\s*\n?\s*\.eq\("id", alertId\)\s*\n?\s*\.is\("resolved_at", null\)/,
    );
  });

  it("attribution is plurality-safe for a platform-global operation", () => {
    // Resolving an ops alert is not studio-scoped, so there is no correct studio
    // to disambiguate with. Exactly ONE active membership attributes; zero or
    // many leaves NULL rather than naming an arbitrary one.
    expect(ACTIONS_CODE).toMatch(/practitionerRows\.length === 1/);
    expect(ACTIONS_CODE).not.toMatch(/\.maybeSingle\(\)|\.single\(\)|\.limit\(1\)/);
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

// SEC-002: these loaders must refuse before constructing a privileged client,
// even when React starts their work without waiting for the parent layout.
const authState = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  error: null as { message: string } | null,
  allowed: true,
}));
const privilegedReads = vi.hoisted(() => ({ clients: 0 }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    privilegedReads.clients += 1;
    throw new Error("PRIVILEGED_CLIENT_CONSTRUCTED");
  },
}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({
    data: { user: authState.user }, error: authState.error,
  }) } }),
}));
vi.mock("@/lib/admin", () => ({
  isAdmin: (email: string) => authState.allowed && email === "operator@hone.example",
}));
import { requirePlatformAdmin } from "@/lib/auth/require-platform-admin";

describe("SEC-002 independently authorized privileged loaders", () => {
  beforeEach(() => {
    authState.user = null; authState.error = null; authState.allowed = true;
    privilegedReads.clients = 0;
  });

  it.each(["ordinary-studio-A", "ordinary-studio-B", "deactivated-member"])(
    "refuses %s without trusting studio role or layout", async (id) => {
      authState.user = { id, email: "member@hone.example" };
      await expect(requirePlatformAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
    },
  );
  it("refuses no session, revoked allowlist and auth error even with stale user data", async () => {
    await expect(requirePlatformAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
    authState.user = { id: "operator", email: "operator@hone.example" };
    authState.allowed = false;
    await expect(requirePlatformAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
    authState.allowed = true;
    authState.error = { message: "session no longer valid" };
    await expect(requirePlatformAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("permits the currently authenticated platform operator without a studio membership", async () => {
    authState.user = { id: "operator", email: "operator@hone.example" };
    await expect(requirePlatformAdmin()).resolves.toBe(authState.user);
  });
  it.each(["ordinary-studio-A", "ordinary-studio-B", "deactivated-member", "former-platform-admin"])(
    "the actual ops loader refuses %s before constructing its privileged client", async (id) => {
      authState.user = { id, email: id === "former-platform-admin" ? "operator@hone.example" : "member@hone.example" };
      authState.allowed = id !== "former-platform-admin";
      const { default: Page } = await import("@/app/admin/ops-alerts/page");
      await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
      expect(privilegedReads.clients).toBe(0);
    },
  );
  it("the actual current-operator loader reaches the privileged-client detector", async () => {
    authState.user = { id: "operator", email: "operator@hone.example" };
    const { default: Page } = await import("@/app/admin/ops-alerts/page");
    await expect(Page()).rejects.toThrow("PRIVILEGED_CLIENT_CONSTRUCTED");
    expect(privilegedReads.clients).toBe(1);
  });
  it.each([
    "app/admin/page.tsx", "app/admin/studios/[id]/page.tsx",
    "app/admin/studios/new/page.tsx", "app/admin/ops-alerts/page.tsx",
    "app/admin/delivery/page.tsx",
  ])("%s guards the loader before service-role construction", (file) => {
    const source = codeOnly(readFileSync(path.join(ROOT, file), "utf8"));
    expect(source).toMatch(/await requirePlatformAdmin\(\);\s*const admin = createAdminClient\(\);/);
  });
});

// A 200 empty Next prefetch tree does not establish that the page ran.
// Preserve full-content positive canaries before the four denied identities.
describe("SEC-002 browser request contract", () => {
  it("independently verifies actual GoTrue identity and membership before each negative request matrix", () => {
    const spec = readFileSync(path.join(ROOT, "e2e/lead-alert-operator.spec.ts"), "utf8");
    const scope = spec.slice(spec.indexOf('test.describe("SEC-002'));
    expect(scope).toContain("const auth = createServerClient(E2E_SUPABASE_URL");
    expect(scope).toContain("await page.context().cookies(E2E_APP_ORIGIN)");
    expect(scope).toContain("await auth.auth.getUser()");
    expect(scope).toContain("expect(error === null).toBe(true)");
    expect(scope).toContain("expect(user?.id).toBe(userId)");
    expect(scope).toContain("expect(user?.email).toBe(email)");
    const negative = scope.slice(scope.indexOf("for (const role of identities)"));
    expect(negative.indexOf("await assertIdentity(page, fixture.userId, emails[role])")).toBeGreaterThan(0);
    expect(negative.indexOf("await assertIdentity(page, fixture.userId, emails[role])")).toBeLessThan(negative.indexOf("for (const pathname of paths())"));
    expect(negative).toContain('active: fixture.active, role: "owner"');
    expect(scope).toContain('const active = role !== "deactivated"');
    expect(scope).toContain('"never-operator"');
    expect(scope).not.toContain('"former-operator"');
  });
  it("proves same-session authority before and after a scoped synthetic revocation with exact restoration", () => {
    const spec = readFileSync(path.join(ROOT, "e2e/lead-alert-operator.spec.ts"), "utf8");
    const scope = spec.slice(spec.indexOf('test("the same operator session loses'));
    expect(scope).toContain("expect(before.status()).toBe(200)");
    expect(scope).toContain("expect(await before.text()).toContain(studios[0].name)");
    expect(scope).toContain('"update auth.users set email = $2 where id = $1 and email = $3 returning id"');
    expect(scope).toContain("expect(changed).toEqual([{ id: operatorId }])");
    expect(scope).toContain("await assertIdentity(page, operatorId, revokedEmail)");
    expect(scope.indexOf("await assertIdentity(page, operatorId, revokedEmail)")).toBeLessThan(scope.indexOf("for (const pathname of paths())"));
    const revoked = scope.slice(scope.indexOf("const changed ="), scope.indexOf("} finally"));
    expect(revoked).not.toContain("signIn(");
    expect(revoked).not.toContain("clearCookies(");
    expect(scope).toMatch(/finally\s*\{\s*await restoreOperatorEmail\(\)/);
    expect(spec).toContain('"update auth.users set email = $2 where id = $1 and email = $3"');
    expect(spec).toContain("[operatorId, OPERATOR, revokedEmail]");
    expect(spec).toContain('expect(restored?.email).toBe(OPERATOR)');
  });

  it("uses full RSC requests and proves protected content before denial checks", () => {
    const spec = readFileSync(path.join(ROOT, "e2e/lead-alert-operator.spec.ts"), "utf8");
    const scope = spec.slice(spec.indexOf('test.describe("SEC-002'));
    expect(scope).toContain('headers: rsc ? { RSC: "1" } : {}');
    expect(scope).not.toContain('"Next-Router-Prefetch": "1"');
    expect(scope).toContain('test.describe.configure({ mode: "serial" })');
    expect(scope.indexOf('test("current platform operator proves full')).toBeLessThan(scope.indexOf('for (const role of identities)'));
    expect(scope).toContain('for (const canary of expected) expect(body).toContain(canary)');
    expect(scope).toContain('expect(body).not.toContain(studio.ownerEmail)');
    expect(scope).toContain('expect(refused,');
  });
});
