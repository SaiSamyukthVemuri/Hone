import type { SetupVerdict } from "@/lib/billing/jurisdiction-setup";

// Gate B. Server-rendered, read-only. A null verdict (unreadable) says so
// instead of implying all is well.
export function JurisdictionStatusPanel({ verdict }: { verdict: SetupVerdict | null }) {
  const unresolved = verdict === null || !verdict.meetsNewSetupStandard;
  return (
    <div role="status" className="rounded border border-neutral-200 p-4 text-sm">
      <h3 className="text-base font-medium">Country and currency check</h3>
      <p className="mt-1">
        {verdict === null
          ? "Hone could not check your country and currency right now. Try again later."
          : verdict.explanation}
      </p>
      {unresolved ? (
        <p className="mt-1 text-neutral-500">This check is advisory. It does not change how payments work today.</p>
      ) : null}
    </div>
  );
}
