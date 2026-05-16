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
        {isOwner && (
          <nav className="mt-6 flex items-center gap-1 border-b border-neutral-200 dark:border-neutral-800">
            <SettingsTab href="/settings/studio" label="Studio" />
            <SettingsTab href="/settings/team" label="Team" />
          </nav>
        )}
      </div>
      {children}
    </div>
  );
}

function SettingsTab({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="-mb-px border-b-2 border-transparent px-4 py-3 text-sm font-medium text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
    >
      {label}
    </Link>
  );
}
