import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { SettingsNav, type SettingsNavItem } from "./SettingsNav";

// Settings layout. The tab list is computed server-side based on
// role; the nav itself is a small client component so it can read
// usePathname for the active tab and drive a mobile <select> change
// handler. Routes are unchanged.

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { practitioner } = await getCurrentPractitionerWithStudio();
  const isOwner = practitioner.role === "owner";

  const items: SettingsNavItem[] = [
    { href: "/settings/profile", label: "Profile" },
    { href: "/settings/launch", label: "Launch" },
    { href: "/settings/intake", label: "Forms & Policies" },
    ...(isOwner
      ? [
          { href: "/settings/studio", label: "Studio" },
          { href: "/settings/team", label: "Team" },
          { href: "/settings/booking", label: "Booking" },
          { href: "/settings/availability", label: "Availability" },
          { href: "/settings/calendar", label: "Breaks & blocks" },
          { href: "/settings/services", label: "Services" },
          { href: "/settings/consent", label: "Consent forms" },
          { href: "/settings/payments", label: "Payments" },
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
