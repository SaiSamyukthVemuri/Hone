"use client";

import { useEffect } from "react";
import { resetDraftRegistry } from "@/lib/note-drafts/draft-registry";

// The signed-in shell owns this. The note-draft registry holds clinical text in this tab and retries saves in the background; sign-out is a SOFT
// navigation (redirect to /login), so module state would otherwise survive it. When the shell unmounts (sign-out, or any move out of the signed-in
// area) every saver is disposed: timers stopped, queued text dropped, late responses inert. The registry is also partitioned by practitioner and
// studio, so a different identity could not reach it even if this did not run.
export function DraftRegistryGuard() {
  useEffect(() => () => resetDraftRegistry(), []);
  return null;
}
