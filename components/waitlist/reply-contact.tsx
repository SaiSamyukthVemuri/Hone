"use client";

import Link from "next/link";
import { useState } from "react";
import { buttonClasses } from "@/components/ui/button";
import { formatPhoneForDisplay, mailtoHref, telHref, type ReplyContact } from "@/lib/waitlist/reply-contact-pure";

// Contact details for one waitlist response card. Everything here is a plain link or a clipboard copy: opening a link or pressing Copy changes no
// state, marks nothing handled, and sends nothing. A response is only closed by its own form on the card.
//
// Two rows with the SAME shape, so they line up: the value on the left (it wraps, so a long address never overflows), and its actions on the right.
// Every contact action has the SAME minimum width and centred label, so Email and Call line up in one column and the two Copy buttons in the next.
const ACTION = buttonClasses({ variant: "secondary", size: "sm", className: "inline-flex min-w-[5rem] items-center justify-center" });

function CopyButton({ value, label, name }: { value: string; label: string; name: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className={ACTION}
      aria-label={state === "idle" ? name : undefined}
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

function Row({ children, actions, testId }: { children: React.ReactNode; actions: React.ReactNode; testId: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1" data-testid={testId}>
      <div className="min-w-0 flex-1 basis-48 break-words [overflow-wrap:anywhere]">{children}</div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}

export function ReplyContactDetails({
  entryId,
  contact,
  showEntryLink = true,
}: {
  entryId: string;
  contact: ReplyContact | null;
  /** False when the entry has been removed from the queue, so the link would land on nothing. */
  showEntryLink?: boolean;
}) {
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
    <div className="mt-2 flex flex-col gap-2" data-testid="reply-contact" data-entry-id={entryId}>
      {contact.email ? (
        <Row
          testId="reply-contact-email"
          actions={
            <>
              <a className={ACTION} href={mailtoHref(contact.email)}>
                Email
              </a>
              <CopyButton value={contact.email} label="Copy" name="Copy email" />
            </>
          }
        >
          <span>{contact.email}</span>
        </Row>
      ) : (
        <Row testId="reply-contact-email" actions={null}>
          <span className="text-neutral-600">No email on this entry</span>
        </Row>
      )}
      {contact.phone ? (
        <Row
          testId="reply-contact-phone"
          actions={
            <>
              {tel && (
                <a className={ACTION} href={tel}>
                  Call
                </a>
              )}
              <CopyButton value={contact.phone} label="Copy" name="Copy phone" />
            </>
          }
        >
          <span>{formatPhoneForDisplay(contact.phone)}</span>
        </Row>
      ) : (
        <Row testId="reply-contact-phone" actions={null}>
          <span className="text-neutral-600">No phone number on this entry</span>
        </Row>
      )}
      {showEntryLink && (
        <Link className="inline-flex min-h-[44px] items-center self-start underline" href={entryHref}>
          Open this waitlist entry
        </Link>
      )}
    </div>
  );
}
