import type { SenderStatusView } from "@/lib/sms/sender-status";

// The SMS sender status card — READ ONLY, and structurally so.
//
// A SERVER component with no "use client", no form, no action, no button and no
// link that could start a provider effect. There is nothing here to press. That
// is not an oversight to be filled in later by adding handlers to this file —
// the controls belong to their own slices, each with its own authority and its
// own proof, and this card is the surface they will render into.
//
// It also names Hone's shared sender in the empty state ON PURPOSE. Every
// studio is in that state today, and an operator reading "no sender configured"
// without being told what happens instead would reasonably conclude their
// appointment texts are not going out. They are — from the deployment-global
// sender, which is a different fact from this studio owning a number.

const TONE_CLASSES: Record<SenderStatusView["tone"], string> = {
  none: "border-neutral-300 dark:border-neutral-700",
  working: "border-blue-300 dark:border-blue-800",
  live: "border-emerald-300 dark:border-emerald-800",
  attention: "border-amber-300 dark:border-amber-800",
  retired: "border-neutral-300 dark:border-neutral-700",
};

// The state is carried by the HEADLINE and the sentence beneath it, never by
// colour alone — the border is reinforcement. A practitioner who cannot
// distinguish amber from emerald still reads "Sender active" or "Setup did not
// finish", which is the whole status.
const TONE_LABEL: Record<SenderStatusView["tone"], string> = {
  none: "Not configured",
  working: "In progress",
  live: "Active",
  attention: "Needs attention",
  retired: "Released",
};

export function SmsSenderStatusCard({ view }: { view: SenderStatusView }) {
  return (
    <div
      data-testid="sms-sender-status"
      data-sender-status={view.status ?? "none"}
      data-sender-tone={view.tone}
      className={`rounded-lg border p-5 ${TONE_CLASSES[view.tone]}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Text messages (SMS)</h3>
        <span className="text-xs font-medium text-neutral-500">
          {TONE_LABEL[view.tone]}
        </span>
      </div>

      <p className="mt-2 text-sm font-medium">{view.headline}</p>
      <p className="mt-1 text-sm text-neutral-500">{view.detail}</p>

      {view.phoneNumber ? (
        <dl className="mt-3 text-sm">
          <dt className="text-neutral-500">Number</dt>
          <dd className="font-medium tabular-nums" data-testid="sms-sender-number">
            {view.phoneNumber}
          </dd>
        </dl>
      ) : null}

      {/* The stored error code is shown verbatim and unglossed. It is a closed,
          non-secret vocabulary (`PROVIDER_ERROR_CODES`), it is what an operator
          would have to quote to get help, and inventing a friendlier sentence
          for it is how a surface starts claiming to know more than the row
          does. The sentence above already says what CAN be said. */}
      {view.errorCode ? (
        <p className="mt-3 text-xs text-neutral-500">
          Reported reason:{" "}
          <code data-testid="sms-sender-error-code">{view.errorCode}</code>
        </p>
      ) : null}

      <p className="mt-3 text-xs text-neutral-500">
        Setting up a studio number is not available in Hone yet. This panel
        reports the current state only.
      </p>
    </div>
  );
}
