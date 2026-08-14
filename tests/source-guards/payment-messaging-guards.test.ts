import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// PR D: permanent source guards for the app-wide smart-payment-status work
// (PRs #336/#337/#338). Runtime surfaces must never regress to static
// payments-are-off / coming-later claims; payment status copy comes from the
// shared presenter layer; admin badges come from the shared row-mode badge.
//
// Exceptions policy (kept deliberately tiny):
//   * docs/ and tests/ are NOT scanned (historical sections + assertions
//     that these strings are absent live there by design);
//   * test-runtime branch copy is allowed ONLY via the explicit per-file
//     allowlists below, each tied to a pinned livemode-ternary shape.

const ROOT = path.resolve(__dirname, "../..");
const RUNTIME_DIRS = ["app", "lib", "components"];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...listFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = RUNTIME_DIRS.flatMap((d) => listFiles(path.join(ROOT, d))).map(
  (f) => ({ rel: path.relative(ROOT, f), src: readFileSync(f, "utf8") }),
);

type Ban = {
  name: string;
  re: RegExp;
  // rel path -> max allowed occurrences (each justified below).
  allow?: Record<string, number>;
};

const BANS: Ban[] = [
  { name: "Live payments are/remain disabled", re: /Live payments (are|remain) disabled/i },
  { name: "Client payments are not enabled", re: /Client payments are not enabled/i },
  { name: "future update (payments-coming-later claim)", re: /future update/i },
  { name: "when card-on-file becomes available", re: /when card-on-file becomes available/i },
  { name: "live refunds are not enabled", re: /live refunds are not enabled/i },
  { name: "live charges are not enabled", re: /live charges are not enabled/i },
  { name: "card-on-file is not enabled", re: /card-on-file is not enabled/i },
  {
    name: "no live charges (allowed only as the Settings test-branch label)",
    re: /no live charges/i,
    allow: { "app/(app)/settings/payments/PaymentsSettings.tsx": 1 },
  },
  {
    name: "test charge wording (allowed only in test-runtime branches)",
    re: /test charge/i,
    allow: {
      // Ternary test branches (shapes pinned below) + a test-branch label.
      "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts": 2, // comment + test branch
      "lib/billing/session-payment-charge.ts": 2, // two ternary test branches
      "lib/onboarding/getting-started.ts": 1, // test-runtime item copy
    },
  },
];

describe("banned stale payment claims (runtime app/lib/components)", () => {
  for (const ban of BANS) {
    it(`no runtime source contains: ${ban.name}`, () => {
      const offenders: string[] = [];
      for (const f of FILES) {
        const count = (f.src.match(new RegExp(ban.re.source, ban.re.flags + "g")) ?? [])
          .length;
        const allowed = ban.allow?.[f.rel] ?? 0;
        if (count > allowed) offenders.push(`${f.rel} (${count} > ${allowed})`);
      }
      expect(offenders, offenders.join("; ")).toEqual([]);
    });
  }

  it("every allowed 'test charge' occurrence sits in a mode-aware shape", () => {
    const action = readFileSync(
      path.join(ROOT, "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts"),
      "utf8",
    );
    expect(action).toMatch(/inferStripeLivemode\(\)\s*\n?\s*\? "Confirm the charge before running it\."\s*\n?\s*: "Confirm the test charge before running it\."/);
    const charge = readFileSync(path.join(ROOT, "lib/billing/session-payment-charge.ts"), "utf8");
    expect(
      charge.match(/livemode\s*\n?\s*\? "We could not start the charge\. Please try again\."\s*\n?\s*: "We could not start the test charge\. Please try again\."/g)?.length,
    ).toBe(2);
    const settings = readFileSync(
      path.join(ROOT, "app/(app)/settings/payments/PaymentsSettings.tsx"),
      "utf8",
    );
    expect(settings).toMatch(/isTestMode \? "Test mode: no live charges" : "Live mode enabled"/);
  });
});

describe("payment status copy comes from the shared presenter layer", () => {
  it("Settings → Payments derives its banner/portal/booking copy from the presenter", () => {
    const page = readFileSync(path.join(ROOT, "app/(app)/settings/payments/page.tsx"), "utf8");
    expect(page).toMatch(/from "@\/lib\/payments\/payment-status-presenter"/);
    expect(page).toMatch(/connectBannerCopy\(/);
    const component = readFileSync(
      path.join(ROOT, "app/(app)/settings/payments/PaymentsSettings.tsx"),
      "utf8",
    );
    expect(component).toMatch(/\{banner\.headline\}/);
    expect(component).toMatch(/\{portalCardMessage\}/);
  });

  it("dashboard payment counts stay mode-scoped; admin status comes from the admin helper", () => {
    const metrics = readFileSync(path.join(ROOT, "lib/dashboard/practice-metrics.ts"), "utf8");
    expect(metrics).toMatch(/\.eq\("stripe_livemode", inferStripeLivemode\(\)\)/);
    const adminHome = readFileSync(path.join(ROOT, "app/admin/page.tsx"), "utf8");
    expect(adminHome).toMatch(/loadPlatformPaymentSummary/);
    const detail = readFileSync(path.join(ROOT, "app/admin/studios/[id]/page.tsx"), "utf8");
    expect(detail).toMatch(/loadStudioPaymentStatus/);
  });
});

describe("admin mode badges are shared and null-safe", () => {
  it("admin pages use AdminModeBadge; no local ModeBadge duplicates under app/admin", () => {
    const admins = FILES.filter((f) => f.rel.startsWith("app/admin"));
    for (const f of admins) {
      expect(f.src, f.rel).not.toMatch(/function ModeBadge\(/);
    }
    expect(
      readFileSync(path.join(ROOT, "app/admin/payments/manual-review/page.tsx"), "utf8"),
    ).toMatch(/AdminModeBadge/);
    expect(
      readFileSync(path.join(ROOT, "app/admin/studios/[id]/page.tsx"), "utf8"),
    ).toMatch(/AdminModeBadge/);
  });

  it("AdminModeBadge goes through modeBadgeForRow and renders null as unknown, never test", () => {
    const badge = readFileSync(path.join(ROOT, "app/admin/mode-badge.tsx"), "utf8");
    expect(badge).toMatch(/modeBadgeForRow/);
    expect(badge).toMatch(/"unknown mode"/);
    const presenter = readFileSync(
      path.join(ROOT, "lib/payments/payment-status-presenter.ts"),
      "utf8",
    );
    expect(presenter).toMatch(/if \(rowLivemode === false\) return "Test";/);
    expect(presenter).toMatch(/return "Unknown";/);
  });
});
