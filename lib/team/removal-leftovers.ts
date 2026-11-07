// What removing a team member could not clear (RBAC G9). The removal itself always succeeded when one of these is reported, so the page says
// "removed; <X> could not be cleared" from a FIXED, whitelisted code in the URL (a thrown error is redacted to "Something went wrong" by the
// app error boundary in production, which reads as if the removal failed). Nothing here comes from user input: unknown codes are dropped.

import { STUDIO_LOCAL_DISCONNECT_NOTICE } from "@/lib/google-calendar/studio-local-disconnect-notice";

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

// "contact support" is right for the first two (we hold the record). `google_access` is not a failure and not a leftover of ours: removal
// deletes only THIS studio's stored credential and never calls Google (a revoke acts on the person's grant and could end their sync in
// another studio), so it is a NOTICE that Hone no longer holds the access and only the person can remove Hone at Google.
export function removalLeftoverMessage(items: readonly RemovalLeftover[]): string {
  const failures = items.filter((i) => i !== "google_access");
  const labels = failures.map((i) => LABEL[i]);
  const list = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : (labels[0] ?? "");
  const parts: string[] = [];
  if (failures.length > 0) {
    parts.push(
      `The team member was removed and can no longer open anything, but we could not also clear their ${list}. Their access is already blocked.`,
      "Contact support to finish clearing the pending invitations or the Google Calendar connection.",
    );
  } else {
    parts.push("The team member was removed and can no longer open anything. Their access is already blocked.");
  }
  if (items.includes("google_access")) {
    parts.push(STUDIO_LOCAL_DISCONNECT_NOTICE);
  }
  return parts.join(" ");
}
