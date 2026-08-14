// Pure, client-safe consent-status helpers (no server-only, no DB). Used by the
// practitioner client-profile card to render per-form status AND an at-a-glance
// pre-treatment summary, and unit-tested without a database/DOM.
//
// States:
//   * not_signed / not_answered, no signature yet (missing).
//   * outdated: signed an OLDER template version than the current active one
//     (needs a re-sign).
//   * signed: up-to-date signature (non-photo).
//   * granted / denied: up-to-date photo_consent answer (denied is a valid,
//     answered, immutable response, NOT "missing").
//
// card_authorization is deliberately EXCLUDED from the summary and keeps its
// legacy row behaviour: it has its own status card + portal re-sign flow, and
// this module must not alter card-authorization logic.

export type ConsentTemplateLite = {
  id: string;
  title: string;
  form_type: string;
  version: number;
};

export type ConsentSigLite = {
  template_version: number;
  response?: string | null;
};

export type ConsentRowState =
  | "signed"
  | "not_signed"
  | "outdated"
  | "granted"
  | "denied"
  | "not_answered";

// Per-template status. For card_authorization we intentionally ignore version
// (no "outdated" state) so its existing behaviour is unchanged.
export function consentRowState(
  template: Pick<ConsentTemplateLite, "form_type" | "version">,
  sig: ConsentSigLite | undefined,
): ConsentRowState {
  const isPhoto = template.form_type === "photo_consent";
  if (!sig) return isPhoto ? "not_answered" : "not_signed";
  if (
    template.form_type !== "card_authorization" &&
    sig.template_version < template.version
  ) {
    return "outdated";
  }
  if (isPhoto) return sig.response === "denied" ? "denied" : "granted";
  return "signed";
}

// True when a form still needs the client's action before treatment.
// "denied"/"granted"/"signed" are complete; only missing + outdated remain.
export function consentRowNeedsAttention(state: ConsentRowState): boolean {
  return (
    state === "not_signed" || state === "not_answered" || state === "outdated"
  );
}

export type ConsentSummary = {
  total: number; // non-card active forms
  notSigned: number; // missing signature/answer
  outdated: number; // signed an older version
  needsAttention: number; // notSigned + outdated
};

// Pre-treatment summary across the studio's NON-card active consent forms.
export function summarizeConsent(
  templates: ConsentTemplateLite[],
  sigByTemplateId: Map<string, ConsentSigLite>,
): ConsentSummary {
  let total = 0;
  let notSigned = 0;
  let outdated = 0;
  for (const t of templates) {
    if (t.form_type === "card_authorization") continue;
    total += 1;
    const state = consentRowState(t, sigByTemplateId.get(t.id));
    if (state === "not_signed" || state === "not_answered") notSigned += 1;
    else if (state === "outdated") outdated += 1;
  }
  return { total, notSigned, outdated, needsAttention: notSigned + outdated };
}
