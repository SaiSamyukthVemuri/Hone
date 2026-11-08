// Pure helpers + type for the client profile tab system. Server components
// import from here; the client component (profile-tab-bar.tsx) re-exports
// these for its own use. Splitting avoids the Next.js "use client" boundary
// error where a server component tries to call a function exported from a
// client module.
//
// ONE tab union, defined here (tests/db/client-profile-tab-*.db.test.ts read
// this declaration as the product's tab vocabulary). The order, labels and the
// owner-only Billing tab are lib/clients/profile-tabs.ts, which imports this
// type so the two cannot drift.
//
// Tab URL values:
//   overview, sessions, treatment (plans + consultation + skin/hair + budget),
//   photos, health, messages (portal access + messages), notes (pinned +
//   personal notes), billing (owner only).
// Legacy ?tab=consultation and ?tab=personal are redirected (see profile-tabs).

export type ProfileTab =
  | "overview"
  | "sessions"
  | "treatment"
  | "photos"
  | "health"
  | "messages"
  | "notes"
  | "billing";

export function isProfileTab(value: string | null | undefined): value is ProfileTab {
  return (
    value === "overview" ||
    value === "sessions" ||
    value === "treatment" ||
    value === "photos" ||
    value === "health" ||
    value === "messages" ||
    value === "notes" ||
    value === "billing"
  );
}
