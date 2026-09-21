import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { FullConfig } from "@playwright/test";
import { E2E_DB_URL } from "./helpers/local-env";
import { runSchemaPreflight } from "./helpers/schema-preflight";

// ===========================================================================
// Playwright globalSetup — ONE hook, shared by every browser lane
// ===========================================================================
//
// ONE MODULE, NOT FOUR. The ordinary, payment, mobile and Google configs all
// derive their origin and environment from `e2e/helpers/local-env.ts` — the
// Google and payment env modules import it directly, and the mobile config
// reuses the payment origin. That makes local-env the single authoritative
// point those lanes already share, so the preflight belongs beside it and each
// config only has to POINT here. Four copies would be four things to drift.
//
// The lane name is derived from the config file Playwright is running, purely
// so the failure message says which lane refused. It never selects a weaker
// check: every lane reaches the same database, so every lane gets the same
// comparison.
//
// WHY globalSetup AND NOT A FIXTURE OR A SPEC
// -------------------------------------------
// A guard written as a spec would run only after the suite had already booted,
// and one written as a fixture would run per test. globalSetup runs once, and
// a throw here means NO TEST EXECUTES — which is the property that matters: no
// browser test can produce misleading evidence against a mismatched stack.
//
// ORDERING, MEASURED RATHER THAN ASSUMED. Against @playwright/test 1.60.0, with
// file-based timestamps so stdout buffering could not flatter the result, the
// webServer starts ~300 ms BEFORE globalSetup — not after it. An earlier read of
// this, taken from stdout, had the order backwards.
//
// The consequence is honest and bounded: a mismatched stack is refused before
// any test runs, but `next build` inside the webServer may already have started,
// so the operator pays some build time before seeing the refusal. That is wasted
// time, not misleading evidence. Gating `npm run e2e:server` itself would also
// save the build, at the cost of three more call sites; it is recorded as an
// option rather than taken, because correctness is already satisfied here.

/** Map a config file to a human lane name for the failure message. */
function laneFor(configFile: string | undefined): string {
  const f = configFile ? basename(configFile) : "";
  if (f.includes("payment")) return "browser e2e (payment / fake-stripe)";
  if (f.includes("mobile")) return "browser e2e (mobile completion)";
  if (f.includes("google")) return "browser e2e (fake-google calendar)";
  if (f.includes("playwright.config")) return "browser e2e (local stack)";
  return `browser e2e (${f || "unknown config"})`;
}

/** Best-effort checkout identity for the failure message. Never fatal. */
function checkoutIdentity(): { branch: string; sha: string } {
  const git = (args: string[]) => {
    try {
      return execFileSync("git", args, { encoding: "utf8", timeout: 10_000 }).trim();
    } catch {
      return "(unavailable)";
    }
  };
  return {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    sha: git(["rev-parse", "HEAD"]),
  };
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const lane = laneFor(config.configFile);
  const context = checkoutIdentity();

  const verdict = await runSchemaPreflight(
    {
      lane,
      // The literal from local-env, which no environment variable can redirect.
      databaseUrl: E2E_DB_URL,
    },
    context,
  );

  if (verdict.ok) {
    // One line, so a passing run still records WHAT it verified against. A
    // guard that is silent on success is a guard nobody can tell is wired up.
    console.log(
      `[e2e schema preflight] OK — ${lane}: ${verdict.matched} migration(s) match between ` +
        `${context.branch}@${context.sha.slice(0, 8)} and the local Supabase stack.`,
    );
  }
}
