import Link from "next/link";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { practitioner } = await getCurrentPractitionerWithStudio();
  const isOwner = practitioner.role === "owner";

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <div className="mt-6 -mx-5 overflow-x-auto border-b border-neutral-200 px-5 dark:border-neutral-800 md:mx-0 md:px-0">
          <nav className="flex items-center gap-1">
            <SettingsTab href="/settings/profile" label="Profile" />
            <SettingsTab href="/settings/intake" label="Intake & Postcare" />
            {isOwner && <SettingsTab href="/settings/studio" label="Studio" />}
            {isOwner && <SettingsTab href="/settings/team" label="Team" />}
            {isOwner && <SettingsTab href="/settings/booking" label="Booking" />}
            {isOwner && (
              <SettingsTab href="/settings/availability" label="Availability" />
            )}
            {isOwner && (
              <SettingsTab href="/settings/calendar" label="Breaks & blocks" />
            )}
            {isOwner && (
              <SettingsTab href="/settings/services" label="Services" />
            )}
            {isOwner && (
              <SettingsTab href="/settings/payments" label="Payments" />
            )}
            {isOwner && <SettingsTab href="/settings/data" label="Data" />}
          </nav>
        </div>
      </div>
      {children}
    </div>
  );
}

function SettingsTab({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="-mb-px whitespace-nowrap border-b-2 border-transparent px-4 py-3 text-sm font-medium text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
    >
      {label}
    </Link>
  );
}
