import "server-only";

import type { MachineProfile } from "./profile-contract";
import { MACHINE_CATALOGUE } from "./catalogue";

/**
 * MPX-03 — the one ACTIVE profile a demo may use, and why it cannot reach
 * production.
 *
 * WHY A SYNTHETIC PROFILE EXISTS AT ALL. Every real profile in the catalogue is
 * `blocked`, because no exact model's evidence is complete. A correct selection
 * UI with an empty picker cannot be demonstrated or acceptance-tested, so the
 * workflow needs exactly one profile that is active by construction rather than
 * by an evidence review it has not passed.
 *
 * IT IS NOT A REAL MACHINE AND SAYS SO. Manufacturer "Synthetic", model "Demo
 * Multineedle", and its evidence entry records that it stands for nothing
 * physical. Nothing about it may be read as a claim about Apilus,
 * Silhouet-Tone or Permanence hardware.
 *
 * ---------------------------------------------------------------------------
 * THREE INDEPENDENT REASONS IT CANNOT REACH PRODUCTION
 * ---------------------------------------------------------------------------
 *
 * 1. `server-only`. This module cannot be imported into a client bundle at all.
 *    The panel receives its selectable profiles FROM the server action, so the
 *    browser never holds the gate and cannot flip it.
 *
 * 2. The flag must be explicitly on. `HONE_SYNTHETIC_MACHINE_PROFILE` must
 *    equal `"1"`. Absent, empty or any other value means off: the gate fails
 *    CLOSED, so forgetting to set it can only ever hide the profile.
 *
 * 3. Any DEPLOYED runtime is refused even if the flag is set, by the same
 *    `deployedEnvironmentSignal` predicate the four other e2e fake-guards use
 *    (Vercel, AWS, Kubernetes). A leaked environment variable in a deployment
 *    therefore changes nothing, which is the point: the flag is not a feature
 *    switch, it is a demo affordance.
 *
 * 4. The instance must be talking to a LOCAL Supabase stack. A deployed Hone
 *    never points at 127.0.0.1, so this is an independent second lock on
 *    reason 3 rather than a restatement of it.
 *
 * All four are asserted in tests, including the leak case.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `NODE_ENV === "production"`, WHICH THIS REPLACED
 * ---------------------------------------------------------------------------
 *
 * Because it refused the one environment the profile exists to serve, and did
 * it silently. Playwright's webServer runs `npm run e2e:server`
 * (`next build && next start`), and next's CLI sets
 * `process.env.NODE_ENV = process.env.NODE_ENV || "production"` for `start`
 * (node_modules/next/dist/bin/next). Nothing in local-env.ts,
 * playwright.config.ts or package.json sets NODE_ENV, so every browser run was
 * NODE_ENV=production and the gate closed BEFORE it ever read the flag.
 *
 * The consequence was worse than a blocked demo: the browser spec's gate-open
 * half could never execute, so it silently proved nothing while reporting
 * green, and the un-run half was hiding a real defect (the panel never
 * persisted a selection). Found by Codex review at 9c6fbbe5, confirmed by
 * reading next's CLI rather than inferred.
 *
 * NODE_ENV describes how the code was BUILT. It does not say where the code is
 * RUNNING, and only the second question is a safety question. Reasons 3 and 4
 * ask the second question, which is why this gate is strictly stronger against
 * a real deployment than the check it replaced: a Vercel PREVIEW was caught
 * before only incidentally, by its NODE_ENV, and is now caught by name.
 */

const SYNTHETIC_PROFILE_ID = "synthetic:demo-multineedle";

/** The flag's required exact value. Anything else is off. */
const FLAG = "HONE_SYNTHETIC_MACHINE_PROFILE";

export const SYNTHETIC_DEMO_PROFILE: MachineProfile = {
  profileId: SYNTHETIC_PROFILE_ID,
  // VERSION 2, because the field set changed and a published contract is
  // immutable per (profile, version). Re-publishing v1 with a third field is
  // refused by `sync_machine_profile_contract` - correctly - so the fixture
  // moves forward rather than mutating history.
  version: 2,
  // It has to sit in one of the curated families for the contract's types, but
  // the manufacturer and model names make clear it is not one of their units.
  family: "Permanence/GEMM-16",
  manufacturer: "Synthetic",
  model: "Demo Multineedle",
  availability: "active",
  verification: "device-confirmed",
  availabilityReason: undefined,
  frequency: { kind: "not-applicable" },
  evidence: [
    {
      id: "synthetic-demo",
      kind: "studio-device-photo",
      consultedOn: "2026-10-12",
      establishes:
        "NOTHING about any real machine. This is a fabricated profile whose only purpose is to make the machine-first workflow demonstrable while every real model is still evidence-gated.",
      doesNotEstablish:
        "Any field, unit, precision, bound or capability of an Apilus, Silhouet-Tone or Permanence unit.",
    },
  ],
  openQuestions: [],
  channels: {
    count: 4,
    nativeLabel: "Channel",
    // The practitioner ruling the real GEMM profile will also carry: a setup
    // saves with no channel named, and per-probe groups are preserved.
    associationRequired: false,
    supportsDistinctSettingGroups: true,
    verification: "device-confirmed",
    evidence: ["synthetic-demo"],
  },
  modes: [
    {
      key: "galvanic",
      nativeLabel: "Galvanic",
      family: "galvanic",
      availability: "active",
      verification: "device-confirmed",
      evidence: ["synthetic-demo"],
      stages: [],
      fields: [
        {
          key: "current",
          nativeLabel: "Current",
          quantity: "current",
          unit: "µA",
          decimals: 0,
          optional: false,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["synthetic-demo"],
        },
        {
          key: "duration",
          nativeLabel: "Time",
          quantity: "duration",
          unit: "s",
          decimals: 1,
          optional: false,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["synthetic-demo"],
        },
        {
          // A MIXED-SOURCE CONTRACT, which is the point of this field.
          //
          // Both fields above are `practitioner-entered`, so no readback of
          // this profile could distinguish per-field provenance from the
          // blanket "practitioner-entered" the entry form used to hard-code.
          // A proof that cannot fail is not a proof, and that is exactly what
          // the provenance assertion was until this existed (Codex, ebc69ff6).
          //
          // `editable: false` as well, so the same fixture also exercises the
          // machine-derived path: the value is transcribed by hand because
          // there is no device integration, and the record says the MACHINE
          // displayed it rather than that she decided it.
          //
          // OPTIONAL, deliberately. A required third field would make every
          // existing save in the browser spec incomplete, and this fixture
          // exists to widen what can be proved, not to rewrite the workflow.
          key: "energy_shown",
          nativeLabel: "Energy shown",
          quantity: "energy-display",
          // `device-display` is the contract's own token for a value in the
          // machine's own arbitrary units. The unit vocabulary is closed on
          // purpose, and inventing "mC" here would be exactly the kind of
          // fiction the closed list prevents.
          unit: "device-display",
          decimals: 2,
          optional: true,
          expectedSource: "machine-displayed",
          editable: false,
          verification: "device-confirmed",
          evidence: ["synthetic-demo"],
        },
      ],
    },
  ],
};

/** Is the synthetic profile enabled for this process? Fails closed. */
/**
 * Is this a deployed runtime? Byte-identical to the predicate in
 * lib/email/e2e-fake-resend.ts, lib/stripe/e2e-fake-guard.ts,
 * lib/reliability/e2e-route-fault.ts and
 * lib/google-calendar/e2e/fake-google-guard.ts, which is the established
 * convention here: each e2e guard keeps its own private copy.
 *
 * Deliberately NOT a shared import, because collapsing five copies means
 * editing four files owned by other lanes mid-sprint. The duplication is a
 * real drift risk and is recorded as a follow-up; all four copies were
 * compared and are identical at the time of writing.
 */
function deployedEnvironmentSignal(env: NodeJS.ProcessEnv): string | null {
  if (env.VERCEL === "1") return "VERCEL";
  if (env.VERCEL_ENV) return `VERCEL_ENV=${env.VERCEL_ENV}`;
  if (env.AWS_REGION || env.AWS_EXECUTION_ENV) return "AWS";
  if (env.KUBERNETES_SERVICE_HOST) return "KUBERNETES";
  return null;
}

/**
 * Reason 4. The same local-only test `e2e/helpers/local-env.ts` enforces by
 * refusing to run at all: a hosted Supabase host, or anything that is not
 * loopback, means this is not a local stack.
 */
const HOSTED_SUPABASE_PATTERNS =
  /supabase\.co|supabase\.com|supabase\.in|pooler\.|amazonaws\.com|rds\.|azure|neon\.tech/i;

function talksToLocalSupabase(env: NodeJS.ProcessEnv): boolean {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return false;
  if (HOSTED_SUPABASE_PATTERNS.test(url)) return false;
  return /127\.0\.0\.1|localhost/.test(url);
}

export function syntheticProfileEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Reasons 3 and 4 first, so no amount of flag-setting can override them.
  if (deployedEnvironmentSignal(env) !== null) return false;
  if (!talksToLocalSupabase(env)) return false;
  // Reason 2: exact value, nothing coerced.
  return env[FLAG] === "1";
}

/**
 * The catalogue a SERVER request should use.
 *
 * Real profiles are always present and always exactly as the curated catalogue
 * states them - this never activates one, and never alters one. The synthetic
 * profile is appended only when the gate above allows it.
 */
export function catalogueForRuntime(
  env: NodeJS.ProcessEnv = process.env,
): readonly MachineProfile[] {
  return syntheticProfileEnabled(env)
    ? [...MACHINE_CATALOGUE, SYNTHETIC_DEMO_PROFILE]
    : MACHINE_CATALOGUE;
}

export { SYNTHETIC_PROFILE_ID };
