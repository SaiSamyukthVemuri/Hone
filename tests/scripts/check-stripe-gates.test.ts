import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #154: Stripe / payment safety grep gates.
//
// The dedicated script `scripts/check-stripe-gates.mjs` enforces the
// payment safety rules. We verify two things from a Vitest run:
//
//   1. Running the script against the current clean repo exits 0
//      and prints PASS for every rule. A regression that adds a new
//      `charges.create` call site in `app/` or `lib/` would flip the
//      exit code; CI would catch it. We anchor the contract here so
//      the rule list cannot silently lose a rule.
//
//   2. The script's textual shape stays right: the scan scope, the
//      allowlists, and the SCRIPT_PATH self-exclusion are present.
//      These are the parts most likely to drift if a future PR
//      moves the script or changes its rule set without thinking.

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT_PATH = path.resolve(REPO_ROOT, "scripts/check-stripe-gates.mjs");
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, "utf8");

describe("check-stripe-gates script (PR #154)", () => {
  it("exits 0 and prints PASS for every rule against the current clean repo", () => {
    const result = spawnSync("node", [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status, result.stderr ?? result.stdout).toBe(0);
    const stdout = result.stdout ?? "";
    // Each documented rule must show up as PASS in the output.
    expect(stdout).toMatch(/^PASS paymentIntents\.create:/m);
    expect(stdout).toMatch(/^PASS charges\.create:/m);
    expect(stdout).toMatch(/^PASS refunds\.create:/m);
    expect(stdout).toMatch(/^PASS checkout\.sessions:/m);
    expect(stdout).toMatch(/^PASS set_studio_require_card_on_file:/m);
    expect(stdout).toMatch(/^PASS STRIPE_ALLOW_LIVE_MODE=true:/m);
    // The PI rule is "exactly one allowed location". The script
    // reports the allowlisted path on success.
    expect(stdout).toContain("lib/billing/manual-fee-charge.ts");
    // The STRIPE_ALLOW_LIVE_MODE=true rule allowlists the
    // assertStripeKeyAllowed error-message location.
    expect(stdout).toContain("lib/stripe/server.ts");
  });

  it("excludes docs, tests, migrations, scripts, and the script itself from the scan", () => {
    // Scan scope must be exactly: app/, lib/, middleware.ts,
    // next.config.ts. Anything that broadens this list would start
    // counting strings in places the gate intentionally ignores.
    expect(SCRIPT_SOURCE).toMatch(/SCAN_ROOTS\s*=\s*\[[^\]]*"app"[^\]]*"lib"/);
    expect(SCRIPT_SOURCE).toMatch(/"middleware\.ts"/);
    expect(SCRIPT_SOURCE).toMatch(/"next\.config\.ts"/);

    // The exclusion list must contain every documented exclusion.
    for (const dir of [
      "node_modules",
      ".next",
      ".git",
      ".github",
      "coverage",
      "docs",
      "tests",
      "supabase",
      "scripts",
    ]) {
      // Match the literal string in the ALWAYS_EXCLUDED_DIRECTORIES
      // Set entries. Each is wrapped in quotes inside the source.
      expect(
        SCRIPT_SOURCE,
        `expected exclusion list to include ${dir}`,
      ).toContain(`"${dir}"`);
    }

    // The script must self-exclude (so future renames don't break
    // it). Pinned as the SCRIPT_PATH check inside isExcludedPath.
    expect(SCRIPT_SOURCE).toMatch(/SCRIPT_PATH\s*=\s*realpathSync/);
    expect(SCRIPT_SOURCE).toMatch(
      /if \(absPath === SCRIPT_PATH\) return true;/,
    );

    // Test files must also be excluded by the .test.ts / .spec.ts
    // pattern.
    expect(SCRIPT_SOURCE).toMatch(
      /TEST_FILE_PATTERN\s*=\s*\/\\\.\(test\|spec\)\\\.\(ts\|tsx\|js\|jsx\)\$\//,
    );
  });

  it("declares the documented allowlists for paymentIntents.create and STRIPE_ALLOW_LIVE_MODE=true", () => {
    expect(SCRIPT_SOURCE).toMatch(
      /name:\s*"paymentIntents\.create"[\s\S]{0,800}allowlist:\s*\[[\s\S]{0,500}"lib\/billing\/manual-fee-charge\.ts"/,
    );
    expect(SCRIPT_SOURCE).toMatch(
      /name:\s*"STRIPE_ALLOW_LIVE_MODE=true"[\s\S]{0,800}allowlist:\s*\[[\s\S]{0,500}"lib\/stripe\/server\.ts"/,
    );
  });
});
