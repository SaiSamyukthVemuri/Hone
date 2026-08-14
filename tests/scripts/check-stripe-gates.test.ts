import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    // PR #320: the requires_action safety cancel, pinned to exactly one site.
    expect(stdout).toMatch(/^PASS paymentIntents\.cancel:/m);
    expect(stdout).toMatch(/^PASS charges\.create:/m);
    expect(stdout).toMatch(/^PASS refunds\.create:/m);
    expect(stdout).toMatch(/^PASS checkout\.sessions:/m);
    expect(stdout).toMatch(/^PASS set_studio_require_card_on_file:/m);
    expect(stdout).toMatch(/^PASS STRIPE_ALLOW_LIVE_MODE=true:/m);
    // PR #321: the getStripe() binding gate (renamed-client evasion guard).
    expect(stdout).toMatch(/^PASS getStripe-binding:/m);
    // The PI rule's single allowed location (PR #218 removed the
    // legacy manual-fee executor; the unified executor remains).
    expect(stdout).toContain("lib/billing/session-payment-charge.ts");
    // The STRIPE_ALLOW_LIVE_MODE=true rule allowlists the
    // assertStripeKeyAllowed error-message location.
    expect(stdout).toContain("lib/stripe/server.ts");
  });

  it("excludes docs, tests, migrations, scripts, and the script itself from the scan", () => {
    // Scan scope must be exactly: app/, lib/, components/ (PR #314),
    // middleware.ts, next.config.ts. Anything that broadens this list would
    // start counting strings in places the gate intentionally ignores; docs/,
    // tests/, migrations/, and scripts/ stay excluded.
    expect(SCRIPT_SOURCE).toMatch(/SCAN_ROOTS\s*=\s*\[[^\]]*"app"[^\]]*"lib"/);
    expect(SCRIPT_SOURCE).toMatch(/"components"/);
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
      /name:\s*"paymentIntents\.create"[\s\S]{0,1200}allowlist:\s*\[[\s\S]{0,1200}"lib\/billing\/session-payment-charge\.ts"/,
    );
    // The dead legacy executor must never return to the allowlist.
    expect(SCRIPT_SOURCE).not.toMatch(/manual-fee-charge\.ts"/);
    expect(SCRIPT_SOURCE).toMatch(
      /name:\s*"STRIPE_ALLOW_LIVE_MODE=true"[\s\S]{0,800}allowlist:\s*\[[\s\S]{0,500}"lib\/stripe\/server\.ts"/,
    );
  });
});

// --------------------------------------------------------------------
// PR #309: complete Stripe-write inventory (non-money rules + catch-all)
// --------------------------------------------------------------------

describe("check-stripe-gates: money-movement gate stays 1/1/0/0 (PR #309)", () => {
  it("prints the exact money-movement PASS lines verify-production.mjs relies on", () => {
    const result = spawnSync("node", [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status, result.stderr ?? result.stdout).toBe(0);
    const stdout = result.stdout ?? "";
    // 1 / 1 / 0 / 0, byte-compatible with the pre-#309 output.
    expect(stdout).toMatch(
      /^PASS paymentIntents\.create: 1 occurrence\(s\), all in allowlisted file\(s\): lib\/billing\/session-payment-charge\.ts:1$/m,
    );
    expect(stdout).toMatch(/^PASS charges\.create: zero runtime source occurrences$/m);
    expect(stdout).toMatch(
      /^PASS refunds\.create: 1 occurrence\(s\), all in allowlisted file\(s\): lib\/billing\/payment-refund\.ts:1$/m,
    );
    expect(stdout).toMatch(/^PASS checkout\.sessions: zero runtime source occurrences$/m);
  });
});

describe("check-stripe-gates: non-money Stripe writes are pinned (PR #309)", () => {
  it("all six non-money writes PASS with exactly-one, in their allowlisted file", () => {
    const result = spawnSync("node", [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status, result.stderr ?? result.stdout).toBe(0);
    const stdout = result.stdout ?? "";
    expect(stdout).toMatch(/^PASS customers\.create: 1 occurrence\(s\), all in allowlisted file\(s\): lib\/stripe\/setup-intent\.ts:1$/m);
    expect(stdout).toMatch(/^PASS setupIntents\.create: 1 occurrence\(s\), all in allowlisted file\(s\): lib\/stripe\/setup-intent\.ts:1$/m);
    expect(stdout).toMatch(/^PASS accounts\.create: 1 occurrence\(s\), all in allowlisted file\(s\): lib\/stripe\/account\.ts:1$/m);
    expect(stdout).toMatch(/^PASS accountLinks\.create: 1 occurrence\(s\), all in allowlisted file\(s\): lib\/stripe\/account\.ts:1$/m);
    expect(stdout).toMatch(/^PASS accounts\.createLoginLink: 1 occurrence\(s\), all in allowlisted file\(s\): lib\/stripe\/account\.ts:1$/m);
    expect(stdout).toMatch(/^PASS confirmSetup \(browser\): 1 occurrence\(s\), all in allowlisted file\(s\): app\/portal\/PortalPaymentMethodForm\.tsx:1$/m);
  });

  it("each non-money rule is exactly-count pinned to exactly one file (source shape)", () => {
    for (const [name, file] of [
      ["customers.create", "lib/stripe/setup-intent.ts"],
      ["setupIntents.create", "lib/stripe/setup-intent.ts"],
      ["accounts.create", "lib/stripe/account.ts"],
      ["accountLinks.create", "lib/stripe/account.ts"],
      ["accounts.createLoginLink", "lib/stripe/account.ts"],
      ["confirmSetup (browser)", "app/portal/PortalPaymentMethodForm.tsx"],
    ] as const) {
      const esc = name.replace(/[.()]/g, (c) => `\\${c}`);
      const re = new RegExp(
        `name:\\s*"${esc}"[\\s\\S]{0,600}allowlist:\\s*\\[[\\s\\S]{0,400}"${file.replace(/\//g, "\\/")}"[\\s\\S]{0,200}exactly:\\s*1`,
      );
      expect(SCRIPT_SOURCE, `expected pinned rule for ${name}`).toMatch(re);
    }
  });

  it("prints PASS for the unknown-write catch-all on the clean repo", () => {
    const result = spawnSync("node", [SCRIPT_PATH], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(result.stdout ?? "").toMatch(/^PASS no-unclassified-stripe-writes:/m);
  });
});

describe("check-stripe-gates: unknown Stripe writes hard-fail (PR #309)", () => {
  // Run the REAL script against a throwaway scan dir so we can inject a
  // fake call site without touching the repo. cwd = tmp → REPO_ROOT = tmp;
  // the script scans tmp/app + tmp/lib. We assert on the catch-all line +
  // a non-zero exit (other rules also fail for want of the real call sites,
  // which is fine, we pin the catch-all's behavior specifically).
  let dir: string | null = null;
  function runAgainst(relFile: string, contents: string) {
    dir = mkdtempSync(path.join(tmpdir(), "stripe-gate-"));
    const abs = path.join(dir, relFile);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf8");
    return spawnSync("node", [SCRIPT_PATH], { cwd: dir, encoding: "utf8" });
  }
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("hard-fails on an unclassified server Stripe write (new verb)", () => {
    const r = runAgainst("lib/x.ts", "const stripe = {};\nawait stripe.paymentIntents.capture(id);\n");
    expect(r.status).not.toBe(0);
    expect(r.stdout ?? "").toMatch(/^FAIL no-unclassified-stripe-writes:/m);
    expect(r.stdout ?? "").toContain("paymentIntents.capture");
    expect(r.stdout ?? "").toContain("lib/x.ts");
  });

  it("hard-fails on an unclassified server Stripe write (new namespace)", () => {
    const r = runAgainst("app/y.ts", "await stripe.terminal.readers.create({});\n");
    expect(r.status).not.toBe(0);
    expect(r.stdout ?? "").toMatch(/^FAIL no-unclassified-stripe-writes:/m);
    expect(r.stdout ?? "").toContain("terminal.readers.create");
  });

  it("hard-fails on an unclassified browser Stripe write (confirmPayment)", () => {
    const r = runAgainst("app/z.tsx", "const { error } = await stripe.confirmPayment({});\n");
    expect(r.status).not.toBe(0);
    expect(r.stdout ?? "").toMatch(/^FAIL no-unclassified-stripe-writes:/m);
    expect(r.stdout ?? "").toContain("confirmPayment");
  });

  it("does NOT fail the catch-all on comment-only Stripe method mentions", () => {
    const r = runAgainst(
      "lib/c.ts",
      "// we intentionally do not call stripe.paymentIntents.capture here\n/* nor stripe.foo.update */\nexport const x = 1;\n",
    );
    expect(r.stdout ?? "").toMatch(/^PASS no-unclassified-stripe-writes:/m);
  });

  it("does NOT fail the catch-all on read-only Stripe calls (retrieve/list)", () => {
    const r = runAgainst(
      "lib/r.ts",
      "await stripe.paymentIntents.retrieve(id);\nawait stripe.accounts.retrieve(a);\nawait stripe.customers.list();\n",
    );
    expect(r.stdout ?? "").toMatch(/^PASS no-unclassified-stripe-writes:/m);
  });

  it("does NOT fail the catch-all when only the classified writes appear", () => {
    const r = runAgainst(
      "lib/ok.ts",
      "await stripe.customers.create({});\nawait stripe.accounts.createLoginLink(a);\nconst e = await stripe.confirmSetup({});\n",
    );
    expect(r.stdout ?? "").toMatch(/^PASS no-unclassified-stripe-writes:/m);
  });
});

// --------------------------------------------------------------------
// PR #321: renamed-client evasion guard + generic dangerous-resource deny
// --------------------------------------------------------------------

describe("check-stripe-gates: getStripe() binding convention (PR #321)", () => {
  let dir: string | null = null;
  function runAgainst(files: Record<string, string>) {
    dir = mkdtempSync(path.join(tmpdir(), "stripe-bind-"));
    for (const [rel, contents] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, contents, "utf8");
    }
    return spawnSync("node", [SCRIPT_PATH], { cwd: dir, encoding: "utf8" });
  }
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  // The exact evasion the gate exists to stop: a renamed client whose member
  // calls (`s.*`) never match the `stripe.<ns>.<method>` inventory/catch-all.
  it("HARD-FAILS a renamed client (const s = getStripe(); s.transfers.create)", () => {
    const r = runAgainst({
      "lib/evil.ts": "const s = getStripe();\nawait s.transfers.create({});\n",
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout ?? "").toMatch(/^FAIL getStripe-binding:/m);
    expect(r.stdout ?? "").toContain("lib/evil.ts");
    // Proof this WAS an evasion: the catch-all alone did not see `s.transfers`.
    expect(r.stdout ?? "").toMatch(/^PASS no-unclassified-stripe-writes:/m);
  });

  it("HARD-FAILS another renamed client (const client = getStripe(); client.refunds.create)", () => {
    const r = runAgainst({
      "lib/e2.ts": "const client = getStripe();\nawait client.refunds.create({});\n",
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout ?? "").toMatch(/^FAIL getStripe-binding:/m);
  });

  it("HARD-FAILS a destructured client (const { paymentIntents } = getStripe())", () => {
    const r = runAgainst({
      "lib/e3.ts": "const { paymentIntents } = getStripe();\nawait paymentIntents.create({});\n",
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout ?? "").toMatch(/^FAIL getStripe-binding:/m);
  });

  it("HARD-FAILS an inline client chain (getStripe().payouts.create)", () => {
    const r = runAgainst({
      "app/e4.ts": "await getStripe().payouts.create({});\n",
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout ?? "").toMatch(/^FAIL getStripe-binding:/m);
  });

  it("PASSES the binding gate for the canonical `const stripe = getStripe()`", () => {
    const r = runAgainst({
      "lib/good.ts": "const stripe = getStripe();\nawait stripe.customers.create({});\n",
    });
    // The binding gate specifically passes (other count rules may fail for a
    // synthetic file, but the getStripe-binding line must be PASS).
    expect(r.stdout ?? "").toMatch(/^PASS getStripe-binding:/m);
    expect(r.stdout ?? "").not.toMatch(/^FAIL getStripe-binding:/m);
  });

  it("does NOT flag the getStripe DEFINITION site (function getStripe())", () => {
    const r = runAgainst({
      "lib/stripe/server.ts": "export function getStripe() {\n  return {};\n}\n",
    });
    expect(r.stdout ?? "").toMatch(/^PASS getStripe-binding:/m);
  });

  it("does NOT flag comment-only or import mentions of getStripe", () => {
    const r = runAgainst({
      "lib/c.ts": "// const s = getStripe(); is forbidden\nimport { getStripe } from '@/lib/stripe/server';\nexport const x = 1;\n",
    });
    expect(r.stdout ?? "").toMatch(/^PASS getStripe-binding:/m);
  });

  // Generic deny: with `stripe` enforced, any dangerous mutating resource is a
  // `stripe.<ns>.<method>` unclassified write → the catch-all denies it.
  it.each([
    "transfers.create",
    "payouts.create",
    "subscriptions.create",
    "invoices.create",
    "applicationFees.create",
    "charges.create",
  ])("HARD-FAILS a direct dangerous write: stripe.%s", (call) => {
    const r = runAgainst({ "lib/d.ts": `const stripe = getStripe();\nawait stripe.${call}({});\n` });
    expect(r.status).not.toBe(0);
    // charges.create has its own exactly:0 rule; the rest hit the catch-all.
    const failed =
      /^FAIL no-unclassified-stripe-writes:/m.test(r.stdout ?? "") ||
      /^FAIL charges\.create:/m.test(r.stdout ?? "");
    expect(failed, r.stdout).toBe(true);
  });

  it("read-only calls on dangerous resources stay allowed (no overbroadening)", () => {
    const r = runAgainst({
      "lib/reads.ts":
        "const stripe = getStripe();\nawait stripe.invoices.retrieve(i);\nawait stripe.subscriptions.list();\nawait stripe.transfers.retrieve(t);\n",
    });
    expect(r.stdout ?? "").toMatch(/^PASS no-unclassified-stripe-writes:/m);
    expect(r.stdout ?? "").toMatch(/^PASS getStripe-binding:/m);
  });
});
