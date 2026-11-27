import type { ReactNode } from "react";

// HON-40 shell contract, step 0: the MOUNT POINT for the once-per-page search host (open state, typed
// query, the Cmd/Ctrl+K listener). Mounted in layout.tsx above both header containers, because the header
// renders GlobalSearch twice (desktop and compact) and a key listener per instance would open the surface
// and immediately close it. A pass-through today; HON-105 owns this file and replaces the body.
export function SearchProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
