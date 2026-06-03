"use client";

import { useState, useTransition } from "react";
import { createPortalMessageReplyAction } from "./portal-message-actions";

// PR #129. Portal-side reply composer. Hangs off a specific parent
// message (messageId) and posts to the createPortalMessageReplyAction
// server action which:
//   * verifies the client's portal session is valid
//   * re-resolves the parent message by (studio_id, client_id,
//     message_id) so a forged messageId from another studio/client
//     cannot reach this branch
//   * re-checks the current client row is still active + non-archived
//   * inserts the reply with server-resolved studio/client
//   * sends a generic notification email to the studio side that
//     contains NO reply body or clinical detail
//
// Expectation copy (spec): the client must understand that replies
// are reviewed but NOT in real time. The shorter version is rendered
// here to keep the portal card visually calm; appointment-change
// urgency is routed back through Manage / Cancel / Reschedule which
// already exist on the upcoming-appointments cards above.

const REPLY_BODY_MAX = 5000;
const NOT_MONITORED_COPY =
  "Replies are reviewed by the studio, but this is not monitored in real time. For urgent appointment changes, use Manage, Cancel, or Reschedule, or contact the studio directly.";

export function PortalReplyForm({
  messageId,
  studioName,
}: {
  messageId: string;
  studioName: string;
}) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      setError("Reply text is required.");
      return;
    }
    if (trimmed.length > REPLY_BODY_MAX) {
      setError(`Reply must be ${REPLY_BODY_MAX} characters or fewer.`);
      return;
    }
    const fd = new FormData();
    fd.set("message_id", messageId);
    fd.set("body", trimmed);
    startTransition(async () => {
      const r = await createPortalMessageReplyAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setBody("");
      // We deliberately do NOT mention whether the studio-side
      // notification email succeeded. The reply visibility itself is
      // the confirmation; the email is a studio-side metric the
      // client never sees.
      setSuccess("Reply sent.");
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 border-t pt-3"
      style={{ borderColor: "#E5E2D9" }}
    >
      <label className="flex flex-col gap-1.5">
        <span
          className="text-[11px] font-medium uppercase"
          style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
        >
          Reply to {studioName}
        </span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          maxLength={REPLY_BODY_MAX}
          placeholder="Type your reply"
          aria-label={`Reply to ${studioName}`}
          className="w-full bg-transparent px-3 py-2 text-[14px] outline-none"
          style={{ border: "1px solid #E5E2D9", backgroundColor: "#FFFFFF" }}
        />
        <span
          className="text-[11px] tabular-nums"
          style={{ color: "#6B6B6B" }}
        >
          {body.length} / {REPLY_BODY_MAX}
        </span>
      </label>

      <p
        className="text-[12px] leading-relaxed"
        style={{ color: "#6B6B6B" }}
      >
        {NOT_MONITORED_COPY}
      </p>

      {error && (
        <p
          className="text-[13px]"
          style={{ color: "#A03030" }}
          role="alert"
        >
          {error}
        </p>
      )}
      {success && (
        <p
          className="text-[13px]"
          style={{ color: "#0A0A0A" }}
          role="status"
        >
          {success}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || body.trim().length === 0}
        className="self-start px-5 py-2 text-[12px] font-medium uppercase disabled:opacity-50"
        style={{
          backgroundColor: "#0A0A0A",
          color: "#FAFAF7",
          letterSpacing: "0.1em",
        }}
      >
        {pending ? "Sending..." : "Send reply"}
      </button>
    </form>
  );
}
