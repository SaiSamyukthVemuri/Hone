import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  isNewClientWaitlistEnabled,
  isNewClientWaitlistDurableEnabled,
} from "@/lib/booking/new-client-waitlist";
import { createClient } from "@/lib/supabase/server";
import { hasActiveWaitlistEntries } from "@/lib/waitlist/operator-queue-presence";
import { SettingsNav, type SettingsNavItem } from "./SettingsNav";

// Settings layout. The tab list is computed server-side based on
// role; the nav itself is a small client component so it can read
// usePathname for the active tab and drive a mobile <select> change
// handler. Routes are unchanged.

/**
 * Stable empty list for a conditionally-included owner tab.
 *
 * Written as a named constant rather than an inline `: []` on purpose: the
 * owner-gated region of this file is read TEXTUALLY by
 * tests/lib/search/navigation-registry.test.ts, which locates the end of the
 * owner block by its `: []`. A nested one inside that block would truncate the
 * parse and quietly stop that guard from proving search never advertises an
 * owner-only tab to a member.
 */
const NO_TABS: SettingsNavItem[] = [];

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const isOwner = practitioner.role === "owner";
  // WAIT-02. The durable waitlist tab appears for an owner whose studio is
  // BOTH waitlisting new clients AND recording those requests durably — the
  // same subordinate contract the submit path enforces, derived here from the
  // SERVER-RESOLVED slug and never from anything the browser sent.
  //
  // WAITLIST-NAV-VIS-01. ...OR whose studio already holds an entry the operator
  // can still act on (waiting / claimed / invited / expired / released). A
  // studio with a real queue must never lose its navigation to that queue just
  // because the rollout flags are not both set; the flags also drive public
  // booking behaviour, so they are not the lever for exposing a tab. Terminal
  // history (converted / removed) alone does not count.
  //
  // The presence read runs only for an owner, only when the flags have not
  // already answered, on the RLS-scoped user client, HEAD-only. It fails
  // closed (tab hidden). /settings/waitlist stays reachable by URL for an
  // owner in every shape either way — this governs navigation, not access.
  const waitlistLive =
    isNewClientWaitlistEnabled(studio.slug) &&
    isNewClientWaitlistDurableEnabled(studio.slug);
  const waitlistTabVisible =
    isOwner &&
    (waitlistLive ||
      (await hasActiveWaitlistEntries(await createClient(), studio.id)));

  const items: SettingsNavItem[] = [
    { href: "/settings/profile", label: "Profile" },
    { href: "/settings/launch", label: "Launch" },
    { href: "/settings/intake", label: "Forms & Postcare" },
    ...(isOwner
      ? [
          { href: "/settings/studio", label: "Studio" },
          { href: "/settings/team", label: "Team" },
          { href: "/settings/booking", label: "Booking" },
          ...(waitlistTabVisible
            ? [{ href: "/settings/waitlist", label: "Waitlist" }]
            : NO_TABS),
          { href: "/settings/availability", label: "Availability" },
          { href: "/settings/services", label: "Services" },
          { href: "/settings/consent", label: "Consent forms" },
          { href: "/settings/payments", label: "Payments" },
          { href: "/settings/integrations", label: "Integrations" },
          { href: "/settings/tracking", label: "Marketing & analytics" },
          { href: "/settings/import", label: "Import" },
          { href: "/settings/data", label: "Data" },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <SettingsNav items={items} />
      </div>
      {children}
    </div>
  );
}
