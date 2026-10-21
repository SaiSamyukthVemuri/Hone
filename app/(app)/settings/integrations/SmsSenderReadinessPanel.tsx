import { NOT_HIPAA_COVERAGE, type DestinationReadiness } from "@/lib/sms/sender-readiness";

// SMS-SENDER-READY-01 (#824): whether the studio's OWN number can text
// Canadian recipients and US recipients, stated separately because they are
// separate facts. READ ONLY, like the status card above it: no form, no action,
// no provider. The state is carried by words, never by colour alone.

const STATE_CLASSES: Record<DestinationReadiness["state"], string> = {
  not_configured: "text-neutral-600 dark:text-neutral-400",
  pending: "text-blue-800 dark:text-blue-300",
  requires_information: "text-amber-900 dark:text-amber-200",
  active: "text-emerald-800 dark:text-emerald-300",
  suspended: "text-amber-900 dark:text-amber-200",
  failed: "text-red-800 dark:text-red-300",
  unavailable: "text-neutral-600 dark:text-neutral-400",
};

const RECIPIENTS: Record<DestinationReadiness["destination"], string> = {
  CA: "Canadian recipients",
  US: "US recipients",
};

export function SmsSenderReadinessPanel({ rows }: { rows: DestinationReadiness[] }) {
  return (
    <div
      data-testid="sms-sender-readiness"
      className="rounded-lg border border-neutral-300 p-5 dark:border-neutral-700"
    >
      <h3 className="text-sm font-semibold">Studio number readiness by recipient country</h3>
      <ul className="mt-3 flex flex-col gap-3">
        {rows.map((r) => (
          <li
            key={r.destination}
            data-testid={`sms-readiness-${r.destination}`}
            data-readiness-state={r.state}
            className="text-sm"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{RECIPIENTS[r.destination]}</span>
              <span className={`text-xs font-semibold ${STATE_CLASSES[r.state]}`}>{r.label}</span>
            </div>
            <p className="mt-1 text-neutral-500">{r.detail}</p>
            {r.nextAction ? (
              <p className="mt-1 text-xs text-neutral-500">
                Next: {r.nextAction}
                {r.actor === "support" ? " (Hone support)" : r.actor === "owner" ? " (studio owner)" : ""}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-neutral-500">
        This is about a number the studio owns. It does not change how Hone sends
        texts today, and a number that exists or passed one test is not
        registered for US texting by itself.
      </p>
      <p className="mt-1 text-xs text-neutral-500" data-testid="sms-readiness-not-hipaa">
        {NOT_HIPAA_COVERAGE}
      </p>
    </div>
  );
}
