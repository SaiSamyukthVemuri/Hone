import Link from "next/link";
import type { Client } from "@/lib/types/database";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { unarchiveClientAction } from "./[id]/actions";

// Archived clients list for /clients?view=archived. Plain list rather
// than a typeahead because v1 archived counts are small (test clients
// and dedupes); typeahead can be added when the list grows past a
// screen. Rows are pre-sorted by archived_at desc in the query so the
// most recently archived row sits at the top and a misclick-archive
// is recoverable without scrolling.
//
// Each row offers two paths back:
//   * View opens /clients/[id] (which intentionally still resolves
//     archived clients so historical records stay reachable).
//   * Unarchive submits the existing unarchiveClientAction directly.
//     One-click is fine here because un-hiding is non-destructive
//     and the action redirects to the unarchived client's profile
//     so the practitioner sees immediate visual confirmation.
//
// Server component; the small <form> posts to the existing server
// action with no client-side state.
export function ArchivedClientsList({ clients }: { clients: Client[] }) {
  if (clients.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
        No archived clients.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
      {clients.map((c) => (
        <ArchivedClientRow key={c.id} client={c} />
      ))}
    </ul>
  );
}

function ArchivedClientRow({ client }: { client: Client }) {
  const contactBits: string[] = [];
  if (client.email) contactBits.push(client.email);
  if (client.phone) contactBits.push(client.phone);

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <Link
            href={`/clients/${client.id}`}
            className="truncate font-medium hover:underline"
          >
            {client.name}
          </Link>
          <span className="inline-flex items-center rounded-full bg-neutral-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
            Archived
          </span>
        </div>
        {contactBits.length > 0 && (
          <div className="truncate text-xs text-neutral-500">
            {contactBits.join(" · ")}
          </div>
        )}
        {client.archived_at && (
          <div className="mt-0.5 text-[11px] text-neutral-500">
            Archived <FormattedDateTime iso={client.archived_at} />
          </div>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        <Link
          href={`/clients/${client.id}`}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          View
        </Link>
        {/* Inline one-click unarchive. The action clears archived_at +
            archived_by, writes an audit row, and redirects to the
            unarchived client's profile so the practitioner sees the
            row return to active immediately. */}
        <form action={unarchiveClientAction}>
          <input type="hidden" name="client_id" value={client.id} />
          <button
            type="submit"
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Unarchive
          </button>
        </form>
      </div>
    </li>
  );
}
