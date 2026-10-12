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
 * 3. Production is refused even if the flag is set. `VERCEL_ENV === "production"`
 *    or `NODE_ENV === "production"` disables it unconditionally. A leaked
 *    environment variable in production therefore changes nothing, which is the
 *    point: the flag is not a feature switch, it is a demo affordance.
 *
 * All three are asserted in tests, including the leak case.
 */

const SYNTHETIC_PROFILE_ID = "synthetic:demo-multineedle";

/** The flag's required exact value. Anything else is off. */
const FLAG = "HONE_SYNTHETIC_MACHINE_PROFILE";

export const SYNTHETIC_DEMO_PROFILE: MachineProfile = {
  profileId: SYNTHETIC_PROFILE_ID,
  version: 1,
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
      ],
    },
  ],
};

/** Is the synthetic profile enabled for this process? Fails closed. */
export function syntheticProfileEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Reason 3 first, so no amount of flag-setting can override it.
  if (env.VERCEL_ENV === "production") return false;
  if (env.NODE_ENV === "production") return false;
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
