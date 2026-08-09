import type { IntakeConsentFormView } from "@/lib/intake/consent-forms";

// On-demand viewer for the consent text stored INSIDE an intake.
//
// The practitioner review page is a scan surface, not a legal-document viewer.
// #545 rendered `form.bodySnapshot` inline and expanded, which is the concrete
// reason Chloe reported "still their answers are very unclear" and "hard to
// find in all the text": the answer was one short line adrift in several
// paragraphs of consent copy, and the CURRENT status sat below all of it.
//
// This is the SMALLEST disclosure that fixes that without building a second
// consent engine. Portal SIGNED records already have one — SignedConsentViewer
// (#405) — and it is reused unchanged for those. An intake record is not a
// signature and must never be rendered by that component or described with its
// vocabulary, so it gets this: native <details>, collapsed by default, no
// client JavaScript, so the review page stays a server component.
//
// Everything shown is the SNAPSHOT the client actually read at the time, never
// today's template row.
export function IntakeConsentRecordViewer({
  form,
  label,
}: {
  form: IntakeConsentFormView;
  label: string;
}) {
  return (
    <details className="mt-1" data-testid="intake-consent-record-disclosure">
      <summary className="cursor-pointer text-[11px] font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900 dark:text-blue-300">
        {label}
      </summary>
      <div className="mt-2 flex flex-col gap-2 rounded-md border border-neutral-300 bg-white p-3 text-sm dark:border-neutral-700 dark:bg-neutral-950">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-semibold text-neutral-900 dark:text-neutral-100">
            {form.titleSnapshot}
          </p>
          <p className="text-xs text-neutral-500">v{form.templateVersion}</p>
        </div>
        {form.responseLabelSnapshot && (
          <p className="text-neutral-700 dark:text-neutral-300">
            {form.responseLabelSnapshot}
          </p>
        )}
        <p
          data-testid="intake-consent-record-body"
          className="whitespace-pre-wrap break-words text-neutral-700 dark:text-neutral-300"
        >
          {form.bodySnapshot}
        </p>
      </div>
    </details>
  );
}
