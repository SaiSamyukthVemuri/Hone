// Pure helpers + type for the client profile tab system. Server components
// import from here; the client component (profile-tab-bar.tsx) re-exports
// these for its own use. Splitting avoids the Next.js "use client" boundary
// error where a server component tries to call a function exported from a
// client module.

export type ProfileTab = "overview" | "personal" | "health" | "treatment";

export function isProfileTab(value: string | null | undefined): value is ProfileTab {
  return (
    value === "overview" ||
    value === "personal" ||
    value === "health" ||
    value === "treatment"
  );
}
