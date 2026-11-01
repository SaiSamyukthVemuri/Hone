import { getNewClientReadiness } from "@/lib/booking/new-client-readiness";
import { isLaunchComplete } from "@/lib/settings/launch-completion";
import type { SettingsNavEntry } from "@/lib/settings/nav";

// Launch checklist rail entry (Team, WS-D). Shown to the OWNER only, and only
// while setup is incomplete; a complete studio no longer sees it. Hiding it is
// navigation, never access: the page keeps its own owner refusal and its own
// redirect to Profile once complete (app/(app)/settings/launch/page.tsx).
//
// Completion is the ONE shared predicate, `isLaunchComplete`, the same one the
// page and the dashboard use. Anything but a settled "ready" counts as NOT
// complete, so an unreadable studio keeps its checklist, and a throw here hides
// the entry (resolveSettingsNav fails closed). `roles` is evaluated first, so a
// practitioner never triggers the readiness read.
export const launchNav: ReadonlyArray<SettingsNavEntry> = [
  {
    id: "launch",
    group: "setup",
    label: "Setup",
    href: "/settings/launch",
    roles: ["owner"],
    visibleWhen: async ({ studio }) =>
      !isLaunchComplete(await getNewClientReadiness(studio), studio),
    order: 10,
  },
];
