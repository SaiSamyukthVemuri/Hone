import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { resolveSettingsNavWithReachable } from "@/lib/settings/nav";
import { SETTINGS_NAV } from "@/lib/settings/nav-registry";
import { SettingsShell } from "@/components/settings/settings-shell";

// Settings layout. The rail is evaluated on the SERVER from the nav registry
// (lib/settings/nav-registry.ts): entries are filtered by the signed-in role
// and each entry's own visibleWhen, and only the filtered list reaches the
// browser, so an owner-only entry is never shipped to a practitioner. Hiding an
// entry is navigation, never access: every settings page keeps its own gate.
// Routes are unchanged.

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  const role = practitioner.role === "owner" ? "owner" : "practitioner";
  const { items, reachable } = await resolveSettingsNavWithReachable(SETTINGS_NAV, { role, studio });

  return (
    <SettingsShell
      items={items}
      reachable={reachable}
      account={{
        name: practitioner.display_name || practitioner.email,
        roleLabel: role === "owner" ? "Owner" : "Practitioner",
      }}
    >
      {children}
    </SettingsShell>
  );
}
