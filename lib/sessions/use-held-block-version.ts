import { useState } from "react";

/**
 * THE BLOCK VERSION AN OPEN EDITOR SAVES AGAINST (Insurance N-4).
 *
 * It is the version the editor OPENED at, and it moves only when the editor's own machine identity write hands back the new
 * one (`adopt`). A newer `propVersion` (a page revalidation, possibly carrying someone else's edit) is never adopted, so a
 * concurrent edit stays refused as "changed elsewhere" instead of being masked. The editor unmounts on close, so the next
 * open starts from the fresh prop.
 */
export function useHeldBlockVersion(propVersion: string | null): [string | null, (token: string) => void] {
  const [held, setHeld] = useState<string | null>(propVersion);
  return [held, setHeld];
}
