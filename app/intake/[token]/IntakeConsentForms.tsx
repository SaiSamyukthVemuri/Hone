"use client";

import type {
  IntakeConsentFormClaim,
  IntakeConsentResponse,
} from "@/lib/intake/consent-forms";

// The studio's real live consent forms, rendered as the final phase of the
// client's own intake: after step 5, before Submit.
//
// The text below is the STUDIO'S, passed down from the server. This component
// hard-codes no consent wording and must never acquire any: it renders
// `form.body` verbatim, unclamped and untruncated, however long the studio
// made it.
//
// NO TYPED NAME. NO SIGN BUTTON. A treatment consent is a checkbox; a photo
// consent is an Accept/Deny radio pair. Nothing here is an electronic
// signature and no copy may say otherwise: the portal's signing ceremony is
// a separate system.

export type RenderedConsentForm = {
  templateId: string;
  formType: "treatment_consent" | "photo_consent";
  title: string;
  description: string | null;
  body: string;
  version: number;
  renderedTemplateHash: string;
  // Set when the client already completed this EXACT current form through the
  // portal. The form is then rendered read-only: no duplicate acceptance is
  // requested, and a portal DENY is displayed as Denied, not reset.
  portalCompletion: {
    response: "accepted" | "denied";
    signedAtIso: string;
    templateVersion: number;
  } | null;
};

type Props = {
  forms: RenderedConsentForm[];
  // templateId -> the client's current choice. Absent means unanswered, which
  // is the ONLY correct initial state: a treatment box starts unticked and a
  // photo choice starts unselected.
  answers: Record<string, IntakeConsentResponse>;
  onChange: (templateId: string, response: IntakeConsentResponse | null) => void;
  errors: Record<string, string>;
};

// Build the claims the wizard sends alongside the answers: which form, what
// the browser believes it rendered, the canonical hash of the exact text it
// displayed, and the client's choice. Every one of these is a comparand the
// server re-checks against its own row, none of it is authority.
export function buildIntakeConsentClaims(
  forms: RenderedConsentForm[],
  answers: Record<string, IntakeConsentResponse>,
): IntakeConsentFormClaim[] {
  const out: IntakeConsentFormClaim[] = [];
  for (const form of forms) {
    // A form already completed in the portal is not answered again here, so it
    // contributes no claim. The server credits it from the signature itself.
    if (form.portalCompletion) continue;
    const response = answers[form.templateId];
    if (response !== "accepted" && response !== "denied") continue;
    out.push({
      template_id: form.templateId,
      form_type: form.formType,
      rendered_template_hash: form.renderedTemplateHash,
      response,
    });
  }
  return out;
}

// Which forms are still unanswered, for client-side validation only. The
// server gate is the authority; this exists so the client gets a pointed
// message instead of a generic refusal.
export function findIncompleteConsentForms(
  forms: RenderedConsentForm[],
  answers: Record<string, IntakeConsentResponse>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const form of forms) {
    // Already completed in the portal, nothing is required of the client.
    if (form.portalCompletion) continue;
    const response = answers[form.templateId];
    if (form.formType === "treatment_consent") {
      // Only an explicit acceptance completes a treatment consent.
      if (response !== "accepted") {
        errors[form.templateId] =
          "Please confirm you have read and agree to this form.";
      }
      continue;
    }
    // Photo consent: EITHER answer completes it. Denying is not an error.
    if (response !== "accepted" && response !== "denied") {
      errors[form.templateId] = "Please choose Accept or Deny.";
    }
  }
  return errors;
}

export function IntakeConsentForms({
  forms,
  answers,
  onChange,
  errors,
}: Props) {
  return (
    <div className="flex flex-col gap-8">
      {forms.map((form) => {
        const errorId = `consent-error-${form.templateId}`;
        const error = errors[form.templateId];
        return (
          <section
            key={form.templateId}
            className="flex flex-col gap-3"
            data-testid="intake-consent-form"
            data-form-type={form.formType}
          >
            <div>
              <h3 className="text-[17px] font-semibold leading-snug">
                {form.title}
              </h3>
              {form.description && (
                <p className="mt-1 text-sm text-neutral-600">
                  {form.description}
                </p>
              )}
            </div>

            {/*
              The studio's own consent text, verbatim. `whitespace-pre-wrap`
              preserves the studio's paragraphing; `break-words` stops a long
              unbroken string from forcing horizontal scroll at 390px. There
              is deliberately NO line-clamp, max-height or character cap: a
              client must be able to read the whole form they are agreeing to.
            */}
            <div
              className="max-w-full whitespace-pre-wrap break-words rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm leading-relaxed text-neutral-800"
              data-testid="intake-consent-body"
            >
              {form.body}
            </div>

            {form.portalCompletion ? (
              // ALREADY COMPLETED, in the client portal, against this exact
              // current form. Read-only and truthful: no control is rendered,
              // so there is nothing to re-tick and nothing that could silently
              // overwrite the existing answer. A portal DENY stays Denied.
              <p
                className="text-sm font-medium text-neutral-800"
                data-testid="intake-consent-already-completed"
                data-response={form.portalCompletion.response}
              >
                {form.formType === "photo_consent"
                  ? form.portalCompletion.response === "accepted"
                    ? "Already answered: Accepted. You completed this form previously, no need to answer again."
                    : "Already answered: Denied. You completed this form previously, no need to answer again."
                  : "Already agreed. You completed this form previously, no need to agree again."}
              </p>
            ) : form.formType === "treatment_consent" ? (
              <label className="flex min-h-[44px] cursor-pointer items-start gap-3 py-1 text-sm text-neutral-800">
                <input
                  type="checkbox"
                  className="mt-0.5 h-5 w-5 shrink-0 rounded border-neutral-400"
                  data-testid="intake-consent-agree"
                  data-template-id={form.templateId}
                  // Unchecked unless the client explicitly accepted. There is
                  // no code path that defaults this to true.
                  checked={answers[form.templateId] === "accepted"}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(e) =>
                    onChange(form.templateId, e.target.checked ? "accepted" : null)
                  }
                />
                <span>I have read and agree to this form.</span>
              </label>
            ) : (
              <fieldset
                className="flex flex-col gap-1"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
              >
                <legend className="pb-1 text-sm font-medium text-neutral-800">
                  Photo consent
                </legend>
                {(
                  [
                    ["accepted", "Accept"],
                    ["denied", "Deny"],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className="flex min-h-[44px] cursor-pointer items-center gap-3 py-1 text-sm text-neutral-800"
                  >
                    <input
                      type="radio"
                      className="h-5 w-5 shrink-0 border-neutral-400"
                      name={`photo-consent-${form.templateId}`}
                      data-testid={`intake-consent-photo-${value}`}
                      data-template-id={form.templateId}
                      // No default: both start unselected until the client
                      // chooses. Deny is an equally valid completed answer.
                      checked={answers[form.templateId] === value}
                      onChange={() => onChange(form.templateId, value)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
            )}

            {error && (
              <p
                id={errorId}
                role="alert"
                className="text-sm text-red-700"
                data-testid="intake-consent-error"
              >
                {error}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
