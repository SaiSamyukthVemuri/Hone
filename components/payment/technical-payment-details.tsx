// Owner-only, collapsed-by-default disclosure for raw processor identifiers and
// codes. Rendered ONLY when isOwner is true (server-derived, trusted), a
// non-owner gets null, not CSS-hidden content, so the data never reaches a
// non-owner's DOM. Contains identifiers/codes only, never secrets, never full
// payment-method data. Keeps processor internals out of the practitioner card
// while preserving them for the owner + the existing admin/support surfaces.

export type TechnicalRow = { label: string; value: string | null | undefined };

export function TechnicalPaymentDetails({
  isOwner,
  rows,
}: {
  isOwner: boolean;
  rows: ReadonlyArray<TechnicalRow>;
}) {
  if (!isOwner) return null;
  const shown = rows.filter(
    (r) => r.value != null && String(r.value).trim() !== "",
  );
  if (shown.length === 0) return null;
  return (
    <details
      data-testid="technical-payment-details"
      className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900/40"
    >
      <summary className="min-h-[44px] cursor-pointer list-none py-2 text-neutral-500 marker:content-none dark:text-neutral-400">
        Technical payment details
      </summary>
      <dl className="mt-1 flex flex-col gap-1">
        {shown.map((r) => (
          <div key={r.label} className="flex flex-wrap gap-x-2">
            <dt className="text-neutral-500 dark:text-neutral-400">{r.label}:</dt>
            <dd className="break-all font-mono text-neutral-700 dark:text-neutral-300">
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
