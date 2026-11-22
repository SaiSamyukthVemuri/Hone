"use client";

import { useEffect, useState } from "react";

type Format = "datetime" | "date" | "time" | "weekday-date";

type Props = {
  iso: string;
  format?: Format;
  className?: string;
  // An IANA zone (the studio's). Omitted: the viewer's own timezone, as before.
  timeZone?: string;
};

/** Pure, so the zone handling can be tested without a browser. */
export function formatInstant(iso: string, format: Format, timeZone?: string): string {
  const options = timeZone ? { ...optionsFor(format), timeZone } : optionsFor(format);
  return new Date(iso).toLocaleString([], options);
}

function optionsFor(format: Format): Intl.DateTimeFormatOptions {
  switch (format) {
    case "date":
      return { month: "short", day: "numeric", year: "numeric" };
    case "time":
      return { hour: "numeric", minute: "2-digit" };
    case "weekday-date":
      return { weekday: "long", month: "long", day: "numeric" };
    default:
      return {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      };
  }
}

// Renders a timestamp in the browser's local timezone, or in `timeZone` when given. The server can't know
// where the user is, so SSR renders empty; the client fills in on mount.
export function FormattedDateTime({ iso, format = "datetime", className, timeZone }: Props) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (!iso) {
      setText("");
      return;
    }
    setText(formatInstant(iso, format, timeZone));
  }, [iso, format, timeZone]);

  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}

// Convenience variant for "today" header chrome where there is no incoming ISO.
export function FormattedToday({
  format = "weekday-date",
  className,
}: {
  format?: Format;
  className?: string;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    setText(new Date().toLocaleString([], optionsFor(format)));
  }, [format]);

  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}
