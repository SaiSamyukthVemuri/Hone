import Link from "next/link";
import { OwnerOnlyNotice } from "@/components/settings/view-heading";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { countTimesFeedback, listTimesFeedback } from "@/lib/waitlist/times-feedback-owner";
import { waitlistTimesFeedbackEnabled } from "@/lib/waitlist/times-feedback";
import { acknowledgeReplyAction } from "./actions";

// 0319 — replies from people who said the offered times don't work. OWNER ONLY:
// the text is a client's own words and is shown here and nowhere else.
export const dynamic = "force-dynamic";

export default async function RepliesPage({
  searchParams,
}: {
  searchParams?: Promise<{ ack?: string | string[] }>;
}) {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <OwnerOnlyNotice>Only studio owners can see replies to the waitlist.</OwnerOnlyNotice>;
  }
  if (!waitlistTimesFeedbackEnabled()) {
    return (
      <main className="mx-auto max-w-2xl p-4 text-sm">
        <p>Not available yet.</p>
      </main>
    );
  }
  const ackFailed = (await searchParams)?.ack === "failed";
  const [list, total] = await Promise.all([
    listTimesFeedback(studio.id, practitioner.user_id),
    countTimesFeedback(studio.id, practitioner.user_id),
  ]);
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4 text-sm">
      <h1 className="text-lg font-medium">Replies to review</h1>
      <p>
        These people said the times they were offered don&rsquo;t work. Each was returned to the
        waiting list with their original join date when they replied. Nothing has been booked or
        sent to them.
      </p>
      {ackFailed && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-900">
          We couldn&rsquo;t mark that reply as seen. Please try again.
        </p>
      )}
      {list.kind === "unknown" ? (
        <p role="status">We couldn&rsquo;t load the replies just now. Please try again.</p>
      ) : list.rows.length === 0 ? (
        <p>No replies to review.</p>
      ) : (
        <>
        {total.kind === "ok" && total.n > list.rows.length && (
          <p role="status">
            Showing the oldest {list.rows.length} of {total.n}. Mark these as seen to see the rest.
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {list.rows.map((r) => (
            <li key={r.invitationId} className="rounded-lg border p-3">
              <p className="font-medium">{r.entryName}</p>
              <p className="mt-1 whitespace-pre-wrap">{r.note ?? "No message left."}</p>
              <form action={acknowledgeReplyAction} className="mt-2">
                <input type="hidden" name="invitationId" value={r.invitationId} />
                <button type="submit" className="min-h-[44px] underline">
                  Mark as seen
                </button>
              </form>
            </li>
          ))}
        </ul>
        </>
      )}
      <Link href="/settings/waitlist" className="underline">
        Back to the waitlist
      </Link>
    </main>
  );
}
