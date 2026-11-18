import { describeInvitation, type InvitationFacts as Facts } from "@/lib/waitlist/invitation-history";

// The recorded invitation facts for one entry, newest first. Presentation only: no reads, no actions, nothing inferred. The deadline
// and the "expiry recorded at" time are separate lines; a release is "reason not recorded".
export function InvitationFacts({ entryId, history, timeZone, nowMs }: { entryId: string; history: Facts[] | null; timeZone: string; nowMs: number }) {
  if (history === null) {
    return (
      <p role="status" className="text-sm text-neutral-500" data-testid="invitation-facts-unavailable">
        Invitation history is unavailable just now.
      </p>
    );
  }
  if (history.length === 0) {
    return (
      <p className="text-sm text-neutral-500" data-testid="invitation-facts-none">
        No invitation has been recorded for this entry.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2 text-sm" data-testid="invitation-facts" data-entry-id={entryId}>
      {history.map((f) => {
        const d = describeInvitation(f, timeZone, nowMs);
        return (
          <li key={f.invitationId}>
            <p className="font-medium">{d.outcome}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-neutral-600 dark:text-neutral-400">
              {d.facts.map((x) => (
                <div key={x.label} className="contents">
                  <dt>{x.label}</dt>
                  <dd>{x.value}</dd>
                </div>
              ))}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}
