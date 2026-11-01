"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// A server redirect cannot see a URL fragment, so a deep link such as
// /settings/studio#time-format cannot be redirected by the server once that
// section has moved to another page. This renders nothing and, on mount, sends
// the browser to the section's new home when the fragment is one that moved.

export type MovedSections = Readonly<Record<string, string>>;

export function movedSectionTarget(hash: string, moved: MovedSections): string | null {
  const id = hash.replace(/^#/, "");
  return id && Object.prototype.hasOwnProperty.call(moved, id) ? moved[id] : null;
}

export function HashRedirect({ moved }: { moved: MovedSections }) {
  const router = useRouter();
  useEffect(() => {
    const target = movedSectionTarget(window.location.hash, moved);
    if (target) router.replace(target);
  }, [moved, router]);
  return null;
}
