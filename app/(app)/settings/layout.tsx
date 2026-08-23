import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { isNewClientWaitlistDurableEnabled } from "@/lib/booking/new-client-waitlist";
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
  // WAIT-02. The durable waitlist tab appears only for a studio whose waitlist
  // is actually being recorded — a server-only allowlist, derived here from the
  // SERVER-RESOLVED slug and never from anything the browser sent. Before that,
  // the studio's queue is still its inbox and a tab reading "Waiting: 0" would
  // be actively misleading. The page itself stays reachable by URL for an owner
  // regardless, so committed entries never become invisible if the rollout is
  // rolled back.
  const waitlistTabVisible = isOwner && isNewClientWaitlistDurableEnabled(studio.slug);

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
