"use client";

import Link from "next/link";
import { useState } from "react";
import { mailtoHref, telHref, type ReplyContact } from "@/lib/waitlist/reply-contact";

// Contact details for one "replies to review" card. Everything here is a plain link or a clipboard copy: opening a
// link or pressing Copy changes no state, marks nothing handled, and sends nothing. The reply is only marked seen by
// its own "Mark as seen" form.
function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className="min-h-[44px] underline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Couldn’t copy" : label}
    </button>
  );
}

export function ReplyContactDetails({ entryId, contact }: { entryId: string; contact: ReplyContact | null }) {
  const entryHref = `/settings/waitlist#entry-${entryId}`;
  if (contact === null) {
    return (
      <p role="status" className="mt-2 text-neutral-600" data-testid="reply-contact-unavailable">
        We couldn&rsquo;t load this person&rsquo;s contact details just now.
      </p>
    );
  }
  if (contact.kind === "gone") {
    return (
      <p className="mt-2 text-neutral-600" data-testid="reply-contact-gone">
        This waitlist entry no longer exists, so there are no contact details to show.
      </p>
    );
  }
  const tel = contact.phone ? telHref(contact.phone) : null;
  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="reply-contact" data-entry-id={entryId}>
      <div className="flex flex-wrap items-center gap-x-3">
        {contact.email ? (
          <>
            <span className="break-all">{contact.email}</span>
            <a className="min-h-[44px] underline" href={mailtoHref(contact.email)}>
              Email
            </a>
            <CopyButton value={contact.email} label="Copy email" />
          </>
        ) : (
          <span className="text-neutral-600">No email on this entry</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3">
        {contact.phone ? (
          <>
            <span>{contact.phone}</span>
            {tel && (
              <a className="min-h-[44px] underline" href={tel}>
                Call
              </a>
            )}
            <CopyButton value={contact.phone} label="Copy phone" />
          </>
        ) : (
          <span className="text-neutral-600">No phone number on this entry</span>
        )}
      </div>
      <Link className="min-h-[44px] underline" href={entryHref}>
        Open this waitlist entry
      </Link>
    </div>
  );
}
