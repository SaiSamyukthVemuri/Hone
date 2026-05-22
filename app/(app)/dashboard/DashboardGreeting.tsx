"use client";

import { useEffect, useState } from "react";

function getGreetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function cleanDisplayName(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  // Email-looking values mean the practitioner never set display_name; fall
  // back to the no-name variant rather than greeting them by their address.
  if (trimmed.includes("@")) return null;
  return trimmed;
}

// Client component so the greeting comes from the user's local clock, not
// the server's. Renders nothing on the SSR pass to avoid hydration
// mismatch; appears after mount.
export function DashboardGreeting({
  displayName,
}: {
  displayName: string | null;
}) {
  const [greeting, setGreeting] = useState<string | null>(null);

  useEffect(() => {
    const hour = new Date().getHours();
    const base = getGreetingForHour(hour);
    const name = cleanDisplayName(displayName);
    setGreeting(name ? `${base}, ${name}` : base);
  }, [displayName]);

  if (!greeting) return null;

  return (
    <p
      className="font-[var(--font-fraunces)] text-xl text-neutral-500 dark:text-neutral-400"
      style={{ letterSpacing: "-0.01em" }}
    >
      {greeting}
    </p>
  );
}
