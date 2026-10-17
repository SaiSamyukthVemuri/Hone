import "server-only";
import { isLoopbackUrl } from "@/lib/net/loopback";

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
  // NOT a real family. This fixture declared `Permanence/GEMM-16` only
  // because the vocabulary had no synthetic member; it is a fiction and
  // should not claim a manufacturer's lineage.
  family: "Synthetic/Demo",
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

/**
 * A SECOND synthetic unit, so "selecting a machine shows only ITS settings"
 * can actually fail.
 *
 * WHY A SECOND ONE AT ALL. With one model in the catalogue, every proof about
 * switching machines is vacuous: there is nothing to switch to, and a form
 * that cleared nothing would pass identically. The dropdown Sam asked for is
 * only meaningfully testable against two models whose contracts DISAGREE.
 *
 * THE FIELD KEYS ARE CHOSEN TO MAKE THE DANGEROUS CASE REACHABLE:
 *
 *   * `current` is the SAME KEY as the multineedle's, at mA / 2 decimals
 *     against its µA / 0 decimals. This is the case that matters. With
 *     disjoint keys a stale draft would LOOK cleared whether or not anything
 *     cleared it, because the new form would have no box to show the old value
 *     in - so the assertion could not fail. Sharing the key means a value
 *     typed for one machine is visible in the other's field unless it is
 *     deliberately discarded, and it also means a stale µA/0dp label on an
 *     mA/2dp field is exactly the mislabelling the contract exists to stop.
 *   * `pulse_width` exists ONLY here, so "the other model's fields are gone"
 *     is distinguishable from "the other model's fields were relabelled".
 *
 * NO CHANNELS, deliberately: it gives the single-group contrast against the
 * multineedle's four, so the simple path and the channel-group path are both
 * provable against the same seeded twin.
 *
 * A DIFFERENT MODE KEY (`blend`, not `galvanic`) because a seed or a command
 * that hardcodes one mode would otherwise skip this profile's contract
 * silently rather than fail.
 *
 * AND TWO MODES RATHER THAN ONE, which is what makes the panel's mode picker
 * reachable at all: it renders only when a unit offers a choice, so with one
 * mode per profile that branch had never executed in a browser. See the
 * `thermolysis` mode's own comment.
 *
 * EXPLICITLY SYNTHETIC, and gated identically to the multineedle. The product
 * rule is that an unverified manufacturer profile is NEVER activated to make
 * the dropdown look fuller; this is a fixture that says so in its own labels
 * and evidence.
 */
export const SYNTHETIC_SINGLE_PROBE_PROFILE_ID = "synthetic:demo-single-probe";

const SYNTHETIC_SINGLE_PROBE: MachineProfile = {
  profileId: SYNTHETIC_SINGLE_PROBE_PROFILE_ID,
  version: 1,
  family: "Synthetic/Demo",
  manufacturer: "Synthetic",
  model: "Demo Single-probe",
  availability: "active",
  verification: "device-confirmed",
  frequency: { kind: "not-applicable" },
  evidence: [
    {
      id: "synthetic-single",
      kind: "studio-device-photo",
      consultedOn: "2026-10-13",
      establishes:
        "A SYNTHETIC second model, carried only so machine switching and " +
        "per-model field contracts can be proved against two disagreeing " +
        "contracts. It corresponds to no real device.",
    },
  ],
  openQuestions: [],
  modes: [
    {
      key: "blend",
      nativeLabel: "Blend",
      family: "blend",
      availability: "active",
      verification: "device-confirmed",
      evidence: ["synthetic-single"],
      stages: [],
      fields: [
        {
          // SAME KEY as the multineedle, DIFFERENT unit and precision.
          key: "current",
          nativeLabel: "Current",
          quantity: "current",
          unit: "mA",
          decimals: 2,
          optional: false,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["synthetic-single"],
        },
        {
          // Unique to this model.
          key: "pulse_width",
          nativeLabel: "Pulse width",
          quantity: "duration",
          unit: "ms",
          decimals: 0,
          optional: true,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["synthetic-single"],
        },
      ],
    },
    {
      // A SECOND MODE ON ONE UNIT, and until it existed an entire shipped UI
      // branch had never rendered in any browser run.
      //
      // The panel shows its mode picker only `modes.length > 1` - correctly,
      // since one active mode needs no control. But both synthetic profiles
      // carried exactly one mode each, so `machine-mode-picker` and every
      // `machine-mode-<key>` button were unreachable mounted, and the only
      // identity change any proof could exercise was a change of UNIT. A mode
      // change is a DIFFERENT path: same device, same profile, same version,
      // different field contract - and it is the one the draft-discarding fix
      // has to survive with nothing else moving.
      //
      // THE FIELD KEYS ARE CHOSEN TO MAKE THE DANGEROUS CASE REACHABLE, on the
      // same reasoning as the second model's:
      //
      //   * `current` is the SAME KEY as blend's, at µA / 1 decimal against
      //     blend's mA / 2. Sharing the key is what lets a value typed under
      //     one mode be VISIBLE in the other's box if anything failed to
      //     discard it; differing in both unit and precision means a stale
      //     label is detectable too, and `scale(v_value) > v_decimals` in the
      //     recording command makes the precision difference enforceable
      //     rather than cosmetic.
      //   * `intensity` exists only here, and `pulse_width` only in blend, so
      //     "the other mode's fields are GONE" is distinguishable from "the
      //     other mode's fields were RELABELLED".
      //
      // BOTH FIELDS REQUIRED, unlike blend's optional `pulse_width`: a mode
      // switch must leave a save genuinely incomplete rather than
      // accidentally saveable, so the blocking path is exercised too.
      //
      // IT REQUIRES NO INSTALLED OPTION, so `supportedModes` cannot filter it
      // out and the picker is reachable on a unit seeded with no options.
      key: "thermolysis",
      nativeLabel: "Thermolysis",
      family: "thermolysis",
      availability: "active",
      verification: "device-confirmed",
      evidence: ["synthetic-single"],
      stages: [],
      fields: [
        {
          // SAME KEY as blend's, DIFFERENT unit and precision.
          key: "current",
          nativeLabel: "Current",
          quantity: "current",
          unit: "µA",
          decimals: 1,
          optional: false,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["synthetic-single"],
        },
        {
          // Unique to this mode.
          key: "intensity",
          nativeLabel: "Intensity",
          quantity: "intensity",
          unit: "%",
          decimals: 0,
          optional: false,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["synthetic-single"],
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
  // THE HOST MUST BE LOOPBACK, NOT MERELY MENTION IT.
  //
  // This was `/127\.0\.0\.1|localhost/.test(url)`, a substring test, and
  // `https://localhost.example.com` and `https://localhost@db.example.com`
  // both satisfy it while resolving somewhere else entirely. On a
  // self-hosted deployment that none of the platform signals cover, setting
  // the fixture flag with such a URL enabled SYNTHETIC MACHINE PROFILES
  // against a real studio's data (Codex, #860 4298457391).
  //
  // `isLoopbackUrl` parses the URL and compares the hostname, and it is the
  // guard #879 already uses for the e2e stack pair - shared from lib rather
  // than written a second time here, because two spellings of "is this
  // local" is how one of them ends up wrong.
  return isLoopbackUrl(url);
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
    ? [...MACHINE_CATALOGUE, SYNTHETIC_DEMO_PROFILE, SYNTHETIC_SINGLE_PROBE]
    : MACHINE_CATALOGUE;
}

export { SYNTHETIC_PROFILE_ID };
export { SYNTHETIC_SINGLE_PROBE };
