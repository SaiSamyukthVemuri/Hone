import "server-only";
import { createClient } from "@/lib/supabase/server";

// ===========================================================================
// STUDIO LAUNCH READINESS — TREATMENT CONSENT
// ===========================================================================
//
// THE GAP THIS CLOSES. A brand-new studio starts with ZERO consent templates:
// nothing seeds one, and nothing asks for one. The launch checklist could
// therefore read "Done" on every row while the intake collected no consent at
// all, because `lib/intake/consent-gate.ts` treats "this studio has none live"
// as a legitimate empty pass — correctly, since a submit must not be refused on
// a studio's own configuration. The absence has to be surfaced BEFORE a real
// client books, which is what this module exists for.
//
// ONE AUTHORITY, TWO CONSUMERS. The launch checklist
// (app/(app)/settings/launch/page.tsx) and the getting-started checklist
// (lib/onboarding/getting-started.ts) both ask this module. Neither builds its
// own `consent_form_templates` query, so the two surfaces cannot drift into
// disagreeing about whether the same studio is ready. Pinned by
// tests/lib/consent/launch-readiness.test.ts.
//
// THE PREDICATE IS THE INTAKE'S OWN LIVE-FORM CONTRACT, narrowed to one type:
//
//   studio_id = the caller's OWN studio (never a browser-supplied id)
//   form_type = 'treatment_consent'
//   status    = 'active'
//   is_live   = true
//
// `is_live` AND `status` are BOTH required, exactly as the portal query
// (`getActiveConsentTemplatesForPortal`) and the intake gate require them.
// Migration 0072's CHECK (`NOT is_live OR status = 'active'`) makes the second
// structurally redundant today; both are kept so a future migration that
// weakens the CHECK cannot silently turn a draft into launch evidence.
//
// WHY THE FORM TYPE IS A LITERAL HERE, NOT AN IMPORT.
// `INTAKE_CONSENT_COLLECTED_FORM_TYPES` is what the intake asks for TODAY, and
// its own header says widening it is a product decision. Importing it would
// mean that adding, say, `photo_consent` back to the intake silently made a
// photo consent satisfy TREATMENT consent readiness. So the requirement is
// pinned literally, and the RELATIONSHIP that matters — that the type we
// require is a type the intake actually collects — is asserted by a test rather
// than by a coupling that can drift in the wrong direction.
//
// UNKNOWN IS NOT "NOT READY", AND IS NEVER "READY". The result is
// result-bearing for the same reason `getCardAuthorizationCapability` is: a
// failed read collapsed into a boolean becomes a business fact. Reported as
// "not ready" it tells an owner to create a form they already have; reported as
// "ready" it green-lights a launch on no evidence. Both consumers render the
// third state as its own thing.
//
// SCOPE. This is launch-readiness PRESENTATION. It does not gate booking,
// intake, charting or payment; it replaces no RLS policy, no practitioner
// authorization and no consent capture at treatment time. A live template means
// the intake has a form to present — it says NOTHING about whether the wording
// is lawyer-reviewed or enforceable (see known-limitations L13). No consent
// content is created, defaulted or suggested anywhere in this module.
//
// READ-ONLY, and an EXISTENCE question: the projection is `id` with `limit(1)`,
// so no template body is ever loaded to answer it.
// ===========================================================================

/**
 * The one form type that satisfies treatment-consent launch readiness.
 *
 * A member of the `consent_form_templates.form_type` CHECK (migration 0057).
 * `general`, `policy_acknowledgement`, `card_authorization` and `photo_consent`
 * deliberately do NOT satisfy it: a card authorization is a payment artefact
 * and a photo consent is collected in the portal, so neither means the client
 * consented to treatment.
 */
export const LAUNCH_TREATMENT_CONSENT_FORM_TYPE = "treatment_consent" as const;

/** The settings surface an owner is sent to. A real, current route. */
export const CONSENT_SETTINGS_HREF = "/settings/consent";

/**
 * `ready` is a fact; `{ ok: false }` is the absence of one.
 *
 * Deliberately not `boolean`. See "UNKNOWN IS NOT NOT-READY" above.
 */
export type TreatmentConsentReadiness =
  | { ok: true; ready: boolean }
  | { ok: false };

/**
 * Does this studio have at least one live treatment consent template?
 *
 * Studio-scoped twice over: the RLS-backed user client means
 * `is_studio_member(studio_id)` is enforced at the database, and the explicit
 * `.eq("studio_id", …)` is defence in depth. A caller cannot ask about a studio
 * it is not a member of, and never passes a browser-supplied id — both
 * consumers resolve the studio server-side from the practitioner row.
 */
export async function getTreatmentConsentReadiness(
  studioId: string,
): Promise<TreatmentConsentReadiness> {
  try {
    // Inside the try on purpose: client construction is its own failure class.
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("consent_form_templates")
      .select("id")
      .eq("studio_id", studioId)
      .eq("form_type", LAUNCH_TREATMENT_CONSENT_FORM_TYPE)
      .eq("status", "active")
      .eq("is_live", true)
      .limit(1);
    if (error) {
      // Bounded: code + message only. No template title, body or studio id.
      console.error(
        JSON.stringify({
          event: "treatment_consent_readiness_failed",
          code: error.code,
          message: error.message,
          timestamp: new Date().toISOString(),
        }),
      );
      return { ok: false };
    }
    return { ok: true, ready: (data ?? []).length > 0 };
  } catch (thrown) {
    console.error(
      JSON.stringify({
        event: "treatment_consent_readiness_unavailable",
        message: thrown instanceof Error ? thrown.message : "unknown",
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false };
  }
}
