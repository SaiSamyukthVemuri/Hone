"use client";

import { useLayoutEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SETTINGS_HASH_REDIRECTS } from "@/lib/settings/redirects";

// A server redirect cannot see a URL fragment, so an old deep link such as
// /settings/studio#email-notifications cannot be redirected by the server once
// that section has become its own route. This renders nothing and, before first
// paint, sends the browser to the view's new route. A fragment that now points
// at the page we are already on is simply dropped, so nothing jumps to it.

export type MovedSections = Readonly<Record<string, string>>;

export function movedSectionTarget(hash: string, moved: MovedSections): string | null {
  const id = hash.replace(/^#/, "");
  return id && Object.prototype.hasOwnProperty.call(moved, id) ? moved[id] : null;
}

export function HashRedirect({ moved = SETTINGS_HASH_REDIRECTS }: { moved?: MovedSections }) {
  const router = useRouter();
  const pathname = usePathname();
  // Layout effect: runs before the first paint, so the old page is not shown for a moment.
  useLayoutEffect(() => {
    const apply = () => {
      const target = movedSectionTarget(window.location.hash, moved);
      if (!target) return;
      if (target === window.location.pathname) {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      } else {
        router.replace(target);
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [moved, router, pathname]);
  return null;
}
