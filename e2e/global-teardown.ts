import { E2E_DB_URL } from "./helpers/local-env";
import {
  fingerprintDatabaseState,
  readLocalDatabaseState,
  SCHEMA_FINGERPRINT_ENV,
} from "./helpers/schema-preflight";

// ===========================================================================
// Playwright globalTeardown — did the database stay the one we verified?
// ===========================================================================
//
// WHY THIS EXISTS (Codex P1 at 7608081d, e2e/global-setup.ts:71)
// --------------------------------------------------------------
// The preflight in globalSetup is a SNAPSHOT. It proves the database matched
// the checkout when the lane started, and nothing after that. The stack is
// shared, so another worktree can run `supabase db reset --local` while this
// suite is mid-flight; the run then continues against the replacement schema.
// And because the replacement is often similar enough for the specs to still
// pass, the lane would report GREEN about a database it never verified — which
// is the exact measurement-integrity failure the preflight exists to stop,
// merely relocated from before the run to during it.
//
// WHAT THIS DOES, AND WHAT IT DOES NOT
// ------------------------------------
// It does NOT prevent the reset. Preventing it requires real per-worktree
// database isolation — a separate Supabase project per lane, or a reservation
// protocol — which is an architectural change with its own blast radius and is
// deliberately NOT attempted in this bounded repair. That gap is recorded as
// follow-up work, not silently closed here.
//
// What it does is remove the FALSE GREEN. The fingerprint taken at start is
// re-taken at the end, and a run whose database changed underneath fails
// instead of passing. After this, a concurrent reset costs a re-run; before it,
// a concurrent reset cost a wrong answer that looked right.
//
// It is also strictly additive to the pass path: on the overwhelmingly common
// run where nothing reset the stack, this reads one table once and returns.

export default async function globalTeardown(): Promise<void> {
  const expected = process.env[SCHEMA_FINGERPRINT_ENV];
  if (!expected) {
    // globalSetup did not record one, which means it never reached its PASS
    // path — the run was already refused and reported. Nothing to add.
    return;
  }

  let actual: string;
  try {
    // Same shape, same single read-only snapshot as the preflight took, so the
    // two fingerprints are comparable observations rather than two different
    // kinds of measurement.
    actual = fingerprintDatabaseState(await readLocalDatabaseState(E2E_DB_URL, "teardown"));
  } catch (err) {
    // The database became unreadable during the run. That is not a clean pass
    // either: the suite's own evidence was produced against something whose
    // final state cannot be confirmed.
    throw new Error(
      [
        "",
        "=".repeat(72),
        "E2E SCHEMA POSTFLIGHT FAILED — database unreadable at end of run",
        "=".repeat(72),
        "",
        `  ${err instanceof Error ? err.message : String(err)}`,
        "",
        "  The suite ran, but the database it ran against cannot be re-verified,",
        "  so this run's results are not evidence. Re-run against a stack that",
        "  stays available for the whole run.",
        "=".repeat(72),
        "",
      ].join("\n"),
    );
  }

  if (actual === expected) return;

  throw new Error(
    [
      "",
      "=".repeat(72),
      "E2E SCHEMA POSTFLIGHT FAILED — the database changed DURING this run",
      "=".repeat(72),
      "",
      "The preflight verified this database against the checkout before the",
      "suite started. It is not the same database now.",
      "",
      `  database fingerprint at start: ${expected}`,
      `  database fingerprint at end:   ${actual}`,
      "",
      "  The fingerprint covers the applied migration set AND a database",
      "  incarnation, so this also fires when a reset restored the SAME",
      "  migrations — `A -> reset -> A` is still a different database, and a",
      "  run that spanned the replacement is still not evidence.",
      "",
      "Almost certainly another worktree ran `supabase db reset --local` while",
      "this suite was running. The stack is shared — see",
      "scripts/worktree-resources.mjs, SHARED_RESOURCES.",
      "",
      "THIS RUN'S RESULTS ARE NOT EVIDENCE, whether the specs passed or failed.",
      "Part of the suite ran against one schema and part against another, and a",
      "replacement schema is often similar enough that the specs still pass.",
      "",
      "What to do:",
      "  * re-run on a stack no other lane will reset mid-run; or",
      "  * coordinate so no reset lands inside another lane's run.",
      "",
      "  This guard detects the change; it cannot prevent it. Preventing it needs",
      "  per-worktree database isolation, which is a separate change.",
      "=".repeat(72),
      "",
    ].join("\n"),
  );
}
