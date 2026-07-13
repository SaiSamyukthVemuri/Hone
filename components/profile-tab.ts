// Pure helpers + type for the client profile tab system. Server components
// import from here; the client component (profile-tab-bar.tsx) re-exports
// these for its own use. Splitting avoids the Next.js "use client" boundary
// error where a server component tries to call a function exported from a
// client module.
//
// Tab URL values (DEEP-LINK-COMPATIBLE):
//   - "overview" : default landing
//   - "sessions" : per-visit history + treatment time totals
//                  (new value added in the post-retest UX polish PR)
//   - "treatment" : treatment plans only (previously held sessions +
//                   plans; sessions content moved to the new sessions
//                   tab. Old ?tab=treatment links still land here as a
//                   valid tab; they just no longer see session content
//                   on the same page.)
//   - "health" : Health & Forms (intake summary, status, deep link to
//                /clients/[id]/intake)
//   - "personal" : Personal Notes (practitioner-only relationship memory)
//   - "consultation" : Consultation notes + Skin/hair analysis (dated,
//                      append-only clinical records; migration 0126)

export type ProfileTab =
  | "overview"
  | "sessions"
  | "treatment"
  | "messages"
  | "health"
  | "consultation"
  | "personal";

export function isProfileTab(value: string | null | undefined): value is ProfileTab {
  return (
    value === "overview" ||
    value === "sessions" ||
    value === "treatment" ||
    value === "messages" ||
    value === "health" ||
    value === "consultation" ||
    value === "personal"
  );
}
