import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { NAV_ENTRIES, NON_SEARCHABLE_ROUTES } from "@/lib/search/navigation-registry";
import { SETTINGS_NAV } from "@/lib/settings/nav-registry";
import {
  WAITLIST_ARCHIVED_PATH,
  WAITLIST_OVER_INVITE_PATH,
  WAITLIST_PATH,
  WAITLIST_RELEASED_PATH,
  WAITLIST_REPLIES_PATH,
  WAITLIST_SEARCH_PATH,
} from "@/lib/waitlist/paths";

// Every place that links to, redirects to, revalidates or signs a visitor back to the operator waitlist, listed once. When the queue moves, this list is
// the checklist: each file below reads its path from lib/waitlist/paths.ts, so the move cannot leave one behind, and a new link has to be added here.

const ROOT = process.cwd();
const CONSUMERS = [
  // navigation and entry points
  "app/(app)/layout.tsx",
  "app/(app)/MobileMenu.tsx",
  "lib/settings/nav-registry.ts",
  "lib/search/navigation-registry.ts",
  "app/(app)/settings/launch/page.tsx",
  "lib/booking/new-client-readiness.ts",
  "app/(app)/financials/analytics/waitlist-screen.tsx",
  // persisted, emailed and signed-in destinations
  "lib/auth/return-to.ts",
  "lib/email/templates/waitlist-decline-owner.ts",
  "lib/notifications/waitlist-offer-declined.ts",
  "lib/waitlist/lifecycle-notice-cookie.ts",
  // the queue's own pages, links and links between them
  "app/(app)/settings/waitlist/page.tsx",
  "app/(app)/settings/waitlist/replies/page.tsx",
  "app/(app)/settings/waitlist/archived/page.tsx",
  "app/(app)/settings/waitlist/released/page.tsx",
  "app/(app)/settings/waitlist/search/page.tsx",
  "components/waitlist/declined-section.tsx",
  "components/waitlist/reply-contact.tsx",
  "components/waitlist/over-invite-link.tsx",
  // every action that revalidates or redirects to the queue
  "app/(app)/settings/waitlist/actions.ts",
  "app/(app)/settings/waitlist/invite-actions.ts",
  "app/(app)/settings/waitlist/profile-actions.ts",
  "app/(app)/settings/waitlist/consent-actions.ts",
  "app/(app)/settings/waitlist/texts-actions.ts",
  "app/(app)/settings/waitlist/follow-up-actions.ts",
  "app/(app)/settings/waitlist/replies/actions.ts",
  "app/(app)/settings/waitlist/over-invite/actions.ts",
];

describe("deep-link inventory", () => {
  it.each(CONSUMERS)("%s reads the waitlist path from the one module", (f) => {
    const src = readFileSync(join(ROOT, f), "utf8");
    expect(src).toMatch(/from "@\/lib\/waitlist\/paths"/);
  });

  it("the settings nav's Waitlist entry points at the queue", () => {
    const e = SETTINGS_NAV.find((x) => x.id === "waitlist");
    expect(e?.href).toBe(WAITLIST_PATH);
  });

  it("the search registry knows exactly the queue and its five sub-pages, nothing else under it", () => {
    const routes = [...NAV_ENTRIES.map((e) => e.href.split(/[?#]/)[0]), ...NON_SEARCHABLE_ROUTES.map((e) => e.route)].filter((r) => r.startsWith(WAITLIST_PATH));
    expect(new Set(routes)).toEqual(
      new Set([WAITLIST_PATH, WAITLIST_SEARCH_PATH, WAITLIST_REPLIES_PATH, WAITLIST_ARCHIVED_PATH, WAITLIST_RELEASED_PATH, WAITLIST_OVER_INVITE_PATH]),
    );
  });
});
