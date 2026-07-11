import type {
  ConsentFormTemplate,
} from "@/lib/types/database";
import type { PractitionerSignatureSummary } from "@/lib/consent/queries";
import {
  consentRowState,
  summarizeConsent,
} from "@/lib/consent/signature-status";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { SignedConsentViewer } from "@/components/signed-consent-viewer";

// PR #134. Practitioner-side per-client consent card. Renders on the
// client profile. Server Component because it has no interactivity:
// for v1 the practitioner views signed / unsigned state per active
// template; clients are the ones who sign. Future PRs may add
// "send a consent reminder" or "view full signed record" affordances
// from here; both are deferred.
//
// Layout:
//   * One row per active template.
//   * Signed: title + 'Signed <timestamp> v<version>'.
//   * Unsigned: title + 'Not signed' caption.
//
// Archived templates do NOT render here (they are not surfaced as
// "things to chase up on"); historical signatures of now-archived
// templates ARE included indirectly because the latest-per-template
// helper is keyed on template_id regardless of current template
// status. v1 keeps that data out of the card to keep the practitioner
// surface focused.

export function ConsentSignaturesCard({
  clientName,
  activeTemplates,
  latestSignatures,
}: {
  clientName: string;
  activeTemplates: Pick<
    ConsentFormTemplate,
    "id" | "title" | "form_type" | "version"
  >[];
  latestSignatures: PractitionerSignatureSummary[];
}) {
  const latestByTemplateId = new Map<string, PractitionerSignatureSummary>();
  for (const s of latestSignatures) {
    if (!latestByTemplateId.has(s.template_id)) {
      latestByTemplateId.set(s.template_id, s);
    }
  }

  // Pre-treatment summary across the studio's non-card consent forms, so a
  // missing / out-of-date required form is obvious before charting a session.
  const summary = summarizeConsent(activeTemplates, latestByTemplateId);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
            Consent forms
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            Forms {clientName} has signed in the secure client portal.
            Edit the studio&rsquo;s templates in Settings &rarr; Consent forms.
          </p>
        </div>
      </div>

      {summary.total > 0 &&
        (summary.needsAttention === 0 ? (
          <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            All {summary.total} consent form{summary.total === 1 ? "" : "s"} up to
            date for {clientName}.
          </p>
        ) : (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {summary.needsAttention} of {summary.total} consent form
            {summary.total === 1 ? "" : "s"} need attention before treatment
            {(summary.notSigned > 0 || summary.outdated > 0) && (
              <>
                {": "}
                {[
                  summary.notSigned > 0
                    ? `${summary.notSigned} not signed`
                    : null,
                  summary.outdated > 0
                    ? `${summary.outdated} need re-sign`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </>
            )}
            .
          </p>
        ))}

      {activeTemplates.length === 0 ? (
        <p className="text-xs italic text-neutral-500">
          No active consent forms configured for this studio.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {activeTemplates.map((t) => {
            const sig = latestByTemplateId.get(t.id);
            // PR #137: photo_consent has accepted/denied/no-answer. This PR
            // adds an "Outdated" state (signed an OLDER template version than
            // the current active one → needs a re-sign). card_authorization
            // keeps its legacy Signed/Not-signed shape (no outdated) via
            // consentRowState — its re-sign flow lives elsewhere, untouched.
            const isPhoto = t.form_type === "photo_consent";
            const state = consentRowState(t, sig);
            const EMERALD =
              "rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200";
            const AMBER =
              "rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-800 dark:bg-amber-950 dark:text-amber-200";
            const NEUTRAL =
              "rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400";
            const badge = {
              signed: { style: EMERALD, label: "Signed" },
              granted: { style: EMERALD, label: "Consent granted" },
              denied: { style: AMBER, label: "Consent denied" },
              outdated: { style: AMBER, label: "Outdated" },
              not_signed: { style: NEUTRAL, label: "Not signed" },
              not_answered: { style: NEUTRAL, label: "Not answered" },
            }[state];
            const subline =
              state === "granted"
                ? "Granted · "
                : state === "denied"
                  ? "Denied · "
                  : state === "signed" || state === "outdated"
                    ? "Signed "
                    : null;
            return (
              <li
                key={t.id}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950"
              >
                <div className="flex flex-col gap-0.5">
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {t.title}
                  </p>
                  {sig ? (
                    <p className="text-[11px] text-neutral-500">
                      {subline}
                      <FormattedDateTime iso={sig.signed_at} />
                      {" · "}
                      {sig.signature_name}
                      {" · "}
                      v{sig.template_version}
                      {state === "outdated" && (
                        <span className="text-amber-700 dark:text-amber-300">
                          {" · "}re-sign needed (current v{t.version})
                        </span>
                      )}
                    </p>
                  ) : (
                    <p className="text-[11px] text-neutral-500">
                      {isPhoto ? "Not answered" : "Not signed"}
                    </p>
                  )}
                  {sig && (
                    <SignedConsentViewer
                      record={sig}
                      formType={t.form_type}
                      currentVersion={t.version}
                    />
                  )}
                </div>
                <span className={badge.style}>{badge.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
