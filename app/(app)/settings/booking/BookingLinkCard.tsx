"use client";

import { useState } from "react";

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
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable; the URL is visible in the input for manual copy.
    }
  }

  if (variant === "inline") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Your booking link
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="break-all text-sm text-neutral-900 hover:underline dark:text-neutral-100"
          >
            {display}
          </a>
          <button
            type="button"
            onClick={copy}
            className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-white dark:border-neutral-700 dark:hover:bg-neutral-950"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        readOnly
        value={display}
        className="w-full rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
      />
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
