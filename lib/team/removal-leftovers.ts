// What removing a team member could not clear (RBAC G9). The removal itself always succeeded when one of these is reported, so the page says
// "removed; <X> could not be cleared" from a FIXED, whitelisted code in the URL (a thrown error is redacted to "Something went wrong" by the
// app error boundary in production, which reads as if the removal failed). Nothing here comes from user input: unknown codes are dropped.

export const REMOVAL_LEFTOVER_CODES = ["invitations", "google_connection", "google_access"] as const;
export type RemovalLeftover = (typeof REMOVAL_LEFTOVER_CODES)[number];

export function parseRemovalLeftovers(raw: string | string[] | undefined): RemovalLeftover[] {
  const text = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  const wanted = new Set(text.split(",").map((s) => s.trim()));
  return REMOVAL_LEFTOVER_CODES.filter((code) => wanted.has(code));
}

const LABEL: Record<RemovalLeftover, string> = {
  invitations: "pending invitations",
  google_connection: "Google Calendar connection",
  google_access: "Google access",
};

// "contact support" is right for the first two (we hold the record). It is WRONG for Google access: the stored token is already deleted, so
// only the person who owns the Google account can remove Hone from it.
export function removalLeftoverMessage(items: readonly RemovalLeftover[]): string {
  const labels = items.map((i) => LABEL[i]);
  const list = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : (labels[0] ?? "");
  const parts = [
    `The team member was removed and can no longer open anything, but we could not also clear their ${list}. Their access is already blocked.`,
  ];
  const needsSupport = items.some((i) => i !== "google_access");
  if (needsSupport) parts.push("Contact support to finish clearing the pending invitations or the Google Calendar connection.");
  if (items.includes("google_access")) {
    parts.push(
      "Hone's access at Google may remain. Ask them to open their Google Account, go to Security, then Third-party apps and services, and remove Hone.",
    );
  }
  return parts.join(" ");
}
