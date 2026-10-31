// Distinct LOADING state for the clients directory (not an empty state).
export default function ClientsLoading() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading clients">
      <div className="h-9 w-40 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
      <div className="h-24 animate-pulse rounded-lg bg-neutral-100 dark:bg-neutral-900" />
      <div className="h-64 animate-pulse rounded-lg bg-neutral-100 dark:bg-neutral-900" />
    </div>
  );
}
