"use client";

import { useMemo, useState, useTransition } from "react";
import type { PortalMessageForPractitioner } from "@/lib/portal-messages/queries";
import type { PortalMessageReplyForPractitioner } from "@/lib/portal-messages/replies-queries";
import { FormattedDateTime } from "@/components/formatted-date-time";

const SUBJECT_MAX = 160;
const BODY_MAX = 5000;

type ActionFn<T> = (formData: FormData) => Promise<T>;

type CreateResult = { ok: true; messageId: string; emailSent: boolean } | { ok: false; error: string };
type ArchiveResult = { ok: true } | { ok: false; error: string };
// markPortalReplySeenAction returns void to fit the <form action>
// binding; success is observed via the page revalidating with the new
// "Seen" badge.
type MarkSeenAction = (formData: FormData) => Promise<void>;

type Props = {
  clientId: string;
  clientName: string;
  clientHasEmail: boolean;
  clientIsArchived: boolean;
  messages: PortalMessageForPractitioner[];
  // PR #129. Client replies to messages above. Pre-grouped by
  // parent message_id in this component so each row renders its own
  // reply thread without re-filtering on every render. Sorted
  // ascending by created_at upstream so the thread reads top-down.
  replies: PortalMessageReplyForPractitioner[];
  createAction: ActionFn<CreateResult>;
  archiveAction: ActionFn<ArchiveResult>;
  markReplySeenAction: MarkSeenAction;
  practitionerNames: Record<string, string>;
};

// Practitioner-side composer + list for one-way secure portal
// messages. Sits on the client profile overview tab. New messages
// auto-publish; the action creates the row, attempts the email,
// then stamps notification_email_* on the same row so this card can
// render the email-state badge on the next render.
//
// Archive is soft only (status='archived' + archived_at stamped).
// Archived rows render muted but stay visible on the practitioner
// card; the portal home filters them out so a misclick can be
// recovered later (a future un-archive action can simply clear the
// columns).
export function PortalMessagesCard({
  clientId,
  clientName,
  clientHasEmail,
  clientIsArchived,
  messages,
  replies,
  createAction,
  archiveAction,
  markReplySeenAction,
  practitionerNames,
}: Props) {
  // Group replies by parent message id once per render so the message
  // rows don't each re-filter the full array. Memoised on the replies
  // reference identity; this is a small array (likely < 50 rows per
  // client) so the work is trivial, but it also keeps a stable shape
  // for the unread-count badge below.
  const repliesByMessageId = useMemo(() => {
    const m = new Map<string, PortalMessageReplyForPractitioner[]>();
    for (const r of replies) {
      const list = m.get(r.message_id) ?? [];
      list.push(r);
      m.set(r.message_id, list);
    }
    return m;
  }, [replies]);
  const unseenReplyCount = useMemo(
    () =>
      replies.filter(
        (r) => r.practitioner_seen_at == null && r.archived_at == null,
      ).length,
    [replies],
  );
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [archivePending, startArchiveTransition] = useTransition();
  const [archiveError, setArchiveError] = useState<string | null>(null);

  function submit() {
    const trimSubject = subject.trim();
    const trimBody = body.trim();
    if (!trimSubject) {
      setError("Subject is required.");
      return;
    }
    if (trimSubject.length > SUBJECT_MAX) {
      setError(`Subject must be ${SUBJECT_MAX} characters or fewer.`);
      return;
    }
    if (!trimBody) {
      setError("Message body is required.");
      return;
    }
    if (trimBody.length > BODY_MAX) {
      setError(`Message body must be ${BODY_MAX} characters or fewer.`);
      return;
    }
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("subject", trimSubject);
    fd.set("body", trimBody);
    setError(null);
    startTransition(async () => {
      const r = await createAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSubject("");
      setBody("");
      setOpen(false);
    });
  }

  function archive(messageId: string) {
    if (!window.confirm("Archive this message? The client will no longer see it.")) {
      return;
    }
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("message_id", messageId);
    setArchiveError(null);
    startArchiveTransition(async () => {
      const r = await archiveAction(fd);
      if (!r.ok) {
        setArchiveError(r.error);
      }
    });
  }

  const activeMessages = messages.filter((m) => m.archived_at == null);
  const archivedMessages = messages.filter((m) => m.archived_at != null);

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
            Portal messages
            {unseenReplyCount > 0 && (
              <span
                className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium tracking-wider text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                aria-label={`${unseenReplyCount} unseen client replies`}
              >
                {unseenReplyCount} unseen {unseenReplyCount === 1 ? "reply" : "replies"}
              </span>
            )}
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            One-way secure notes to {clientName}. Shown in their portal;
            the email notification does not include the message text.
            Clients can reply inline; you can respond by sending a new
            secure message.
          </p>
        </div>
        {!clientIsArchived && !open && (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setError(null);
            }}
            className="self-start rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            + New message
          </button>
        )}
      </div>

      {clientIsArchived && (
        <p className="text-xs italic text-neutral-500">
          Archived clients cannot receive portal messages.
        </p>
      )}

      {open && !clientIsArchived && (
        <div className="flex flex-col gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900">
          <p className="text-sm font-medium">Send secure portal message</p>
          <p className="text-[11px] text-neutral-500">
            The client will receive an email letting them know there is a
            message in their portal. The email will not include the
            message text.
          </p>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500">
              Subject
            </span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={SUBJECT_MAX}
              placeholder="e.g. Quick note about your next visit"
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500">
              Message
            </span>
            <textarea
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={BODY_MAX}
              placeholder="Share a note for this client. They will see it inside their portal."
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            />
            <span className="text-[11px] text-neutral-500 tabular-nums">
              {body.length} / {BODY_MAX}
            </span>
          </label>

          {!clientHasEmail && (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
              No email on file. The message will appear in the portal,
              but no notification email can be sent.
            </p>
          )}

          {error && (
            <p className="text-xs text-red-700 dark:text-red-400" role="alert">
              {error}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {pending ? "Sending…" : "Send secure portal message"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setSubject("");
                setBody("");
                setError(null);
              }}
              disabled={pending}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {archiveError && (
        <p className="text-xs text-red-700 dark:text-red-400" role="alert">
          {archiveError}
        </p>
      )}

      {activeMessages.length === 0 && archivedMessages.length === 0 ? (
        <p className="text-xs italic text-neutral-500">
          No portal messages yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {activeMessages.map((m) => (
            <li key={m.id}>
              <MessageRow
                m={m}
                replies={repliesByMessageId.get(m.id) ?? []}
                clientId={clientId}
                practitionerNames={practitionerNames}
                onArchive={() => archive(m.id)}
                archiveDisabled={archivePending}
                markReplySeenAction={markReplySeenAction}
              />
            </li>
          ))}
          {archivedMessages.length > 0 && (
            <li className="flex flex-col gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                Archived
              </p>
              <ul className="flex flex-col gap-3">
                {archivedMessages.map((m) => (
                  <li key={m.id}>
                    <MessageRow
                      m={m}
                      replies={repliesByMessageId.get(m.id) ?? []}
                      clientId={clientId}
                      practitionerNames={practitionerNames}
                      onArchive={null}
                      archiveDisabled={false}
                      markReplySeenAction={markReplySeenAction}
                    />
                  </li>
                ))}
              </ul>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function MessageRow({
  m,
  replies,
  clientId,
  practitionerNames,
  onArchive,
  archiveDisabled,
  markReplySeenAction,
}: {
  m: PortalMessageForPractitioner;
  replies: PortalMessageReplyForPractitioner[];
  clientId: string;
  practitionerNames: Record<string, string>;
  onArchive: (() => void) | null;
  archiveDisabled: boolean;
  markReplySeenAction: MarkSeenAction;
}) {
  const archived = m.archived_at != null;
  const reviewed = m.client_reviewed_at != null;
  const author = practitionerNames[m.created_by_practitioner_id] ?? null;
  const emailState: { label: string; tone: "ok" | "fail" | "muted" } = m
    .notification_email_sent_at
    ? { label: "Email sent", tone: "ok" }
    : m.notification_email_error
      ? { label: "Email failed", tone: "fail" }
      : { label: "Email not sent", tone: "muted" };

  return (
    <div
      className={`flex flex-col gap-2 rounded-md border p-3 ${
        archived
          ? "border-neutral-200 bg-neutral-50 opacity-70 dark:border-neutral-800 dark:bg-neutral-900"
          : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {m.subject}
        </p>
        <p className="text-[11px] text-neutral-500">
          <FormattedDateTime iso={m.published_at} />
          {author ? ` · by ${author}` : null}
        </p>
      </div>
      <p className="whitespace-pre-wrap text-xs text-neutral-700 dark:text-neutral-300">
        {m.body}
      </p>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span
          className={
            reviewed
              ? "rounded-full bg-emerald-100 px-2 py-0.5 font-medium uppercase tracking-wider text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
              : "rounded-full bg-amber-100 px-2 py-0.5 font-medium uppercase tracking-wider text-amber-800 dark:bg-amber-950 dark:text-amber-200"
          }
          title={
            reviewed && m.client_reviewed_at
              ? `Reviewed on ${m.client_reviewed_at}`
              : undefined
          }
        >
          {reviewed ? "Reviewed by client" : "Not reviewed yet"}
        </span>
        {reviewed && m.client_reviewed_at && (
          <span className="text-neutral-500">
            <FormattedDateTime iso={m.client_reviewed_at} />
          </span>
        )}
        <span
          className={
            emailState.tone === "ok"
              ? "rounded-full bg-neutral-100 px-2 py-0.5 font-medium uppercase tracking-wider text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              : emailState.tone === "fail"
                ? "rounded-full bg-red-100 px-2 py-0.5 font-medium uppercase tracking-wider text-red-800 dark:bg-red-950 dark:text-red-200"
                : "rounded-full bg-neutral-100 px-2 py-0.5 font-medium uppercase tracking-wider text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
          }
          title={
            emailState.tone === "fail" && m.notification_email_error
              ? m.notification_email_error
              : undefined
          }
        >
          {emailState.label}
        </span>
        {archived && (
          <span className="rounded-full bg-neutral-200 px-2 py-0.5 font-medium uppercase tracking-wider text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
            Archived
          </span>
        )}
        {onArchive && !archived && (
          <button
            type="button"
            onClick={onArchive}
            disabled={archiveDisabled}
            className="ml-auto text-neutral-500 hover:underline disabled:opacity-50"
          >
            Archive
          </button>
        )}
      </div>

      {/* PR #129. Client replies under this parent message. Renders
          only when at least one reply exists; the practitioner card
          stays compact for messages that haven't been replied to. */}
      {replies.length > 0 && (
        <div className="mt-1 flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            Client replies ({replies.length})
          </p>
          <ul className="flex flex-col gap-2">
            {replies.map((r) => (
              <li key={r.id}>
                <ReplyRow
                  r={r}
                  clientId={clientId}
                  markReplySeenAction={markReplySeenAction}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// PR #129. One client reply rendered under its parent message on the
// practitioner card. Surfaces the reply body, timestamp, an "Unseen"
// badge when the practitioner has not yet acknowledged it, and the
// notification-email send state (Email sent / Email failed / Email
// not sent) using the same pill tones as the parent-message email
// badges so the card stays visually uniform. The Mark seen button
// posts the existing markPortalReplySeenAction; on success the
// server-side revalidatePath refreshes the row with a stamped
// practitioner_seen_at.
function ReplyRow({
  r,
  clientId,
  markReplySeenAction,
}: {
  r: PortalMessageReplyForPractitioner;
  clientId: string;
  markReplySeenAction: MarkSeenAction;
}) {
  const archived = r.archived_at != null;
  const seen = r.practitioner_seen_at != null;
  const emailState: { label: string; tone: "ok" | "fail" | "muted" } = r
    .notification_email_sent_at
    ? { label: "Email sent", tone: "ok" }
    : r.notification_email_error
      ? { label: "Email failed", tone: "fail" }
      : { label: "Email not sent", tone: "muted" };

  return (
    <div
      className={`flex flex-col gap-1.5 rounded-md border p-3 ${
        archived
          ? "border-neutral-200 bg-neutral-50 opacity-70 dark:border-neutral-800 dark:bg-neutral-900"
          : seen
            ? "border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900"
            : "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
          Client reply
          {" · "}
          <FormattedDateTime iso={r.created_at} />
        </p>
        {!seen && !archived && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Unseen
          </span>
        )}
        {seen && r.practitioner_seen_at && (
          <span className="text-[10px] text-neutral-500">
            Seen <FormattedDateTime iso={r.practitioner_seen_at} />
          </span>
        )}
      </div>
      <p className="whitespace-pre-wrap text-xs text-neutral-700 dark:text-neutral-300">
        {r.body}
      </p>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span
          className={
            emailState.tone === "ok"
              ? "rounded-full bg-neutral-100 px-2 py-0.5 font-medium uppercase tracking-wider text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              : emailState.tone === "fail"
                ? "rounded-full bg-red-100 px-2 py-0.5 font-medium uppercase tracking-wider text-red-800 dark:bg-red-950 dark:text-red-200"
                : "rounded-full bg-neutral-100 px-2 py-0.5 font-medium uppercase tracking-wider text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
          }
          title={
            emailState.tone === "fail" && r.notification_email_error
              ? r.notification_email_error
              : undefined
          }
        >
          {emailState.label}
        </span>
        {!seen && !archived && (
          <form action={markReplySeenAction} className="ml-auto">
            <input type="hidden" name="reply_id" value={r.id} />
            <input type="hidden" name="client_id" value={clientId} />
            <button
              type="submit"
              className="rounded-md border border-neutral-300 px-2.5 py-1 text-[11px] font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              Mark seen
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
