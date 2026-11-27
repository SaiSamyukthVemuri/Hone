"use client";

import { useId } from "react";
import { SectionLabel } from "@/components/ui/section-label";
import { CopyButton } from "@/components/copy-button";

type Props = {
  slug: string;
  origin?: string;
  variant?: "inline" | "card";
};

export function BookingLinkCard({
  slug,
  origin = "https://hone.care",
  variant = "card",
}: Props) {
  const url = `${origin}/book/${slug}`;
  const display = `${origin.replace(/^https?:\/\//, "")}/book/${slug}`;
  const textId = useId();

  if (variant === "inline") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <SectionLabel as="p">Your booking link</SectionLabel>
        <div className="flex flex-wrap items-center gap-3">
          <a
            id={textId}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="break-all text-sm text-neutral-900 hover:underline dark:text-neutral-100"
          >
            {display}
          </a>
          <CopyButton
            value={url}
            selectTargetId={textId}
            ariaLabel="Copy booking link"
            size="sm"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        id={textId}
        aria-label="Booking link"
        readOnly
        value={display}
        className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
      />
      <CopyButton
        value={url}
        selectTargetId={textId}
        ariaLabel="Copy booking link"
        className="shrink-0"
      />
    </div>
  );
}
