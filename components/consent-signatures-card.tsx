import type {
  ConsentFormTemplate,
} from "@/lib/types/database";
import type { PractitionerSignatureSummary } from "@/lib/consent/queries";
import { FormattedDateTime } from "@/components/formatted-date-time";

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
  activeTemplates: Pick<ConsentFormTemplate, "id" | "title" | "form_type">[];
  latestSignatures: PractitionerSignatureSummary[];
}) {
  const latestByTemplateId = new Map<string, PractitionerSignatureSummary>();
  for (const s of latestSignatures) {
    if (!latestByTemplateId.has(s.template_id)) {
      latestByTemplateId.set(s.template_id, s);
    }
  }

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

      {activeTemplates.length === 0 ? (
        <p className="text-xs italic text-neutral-500">
          No active consent forms configured for this studio.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {activeTemplates.map((t) => {
            const sig = latestByTemplateId.get(t.id);
            // PR #137. Photo-consent forms have three states:
            //   * accepted -> green Consent granted
            //   * denied   -> amber Consent denied (NOT treated as
            //                 missing; the row is a legitimate
            //                 immutable response)
            //   * no row   -> neutral Not answered
            // Every other form_type keeps the legacy Signed /
            // Not signed shape.
            const isPhoto = t.form_type === "photo_consent";
            const badgeStyle = isPhoto
              ? sig
                ? sig.response === "denied"
                  ? "rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                  : "rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                : "rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
              : sig
                ? "rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                : "rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400";
            const badgeLabel = isPhoto
              ? sig
                ? sig.response === "denied"
                  ? "Consent denied"
                  : "Consent granted"
                : "Not answered"
              : sig
                ? "Signed"
                : "Not signed";
            const subline = isPhoto
              ? sig
                ? `${sig.response === "denied" ? "Denied" : "Granted"} · `
                : null
              : sig
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
                    </p>
                  ) : (
                    <p className="text-[11px] text-neutral-500">
                      {isPhoto ? "Not answered" : "Not signed"}
                    </p>
                  )}
                </div>
                <span className={badgeStyle}>{badgeLabel}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
