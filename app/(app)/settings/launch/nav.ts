import type { SettingsNavEntry } from "@/lib/settings/nav";

// Launch checklist rail entry. Today it is visible to every practitioner, as it
// was before the redesign. Team (WS-D) owns this file from here on: "owner-only
// Setup while incomplete, gone after completion" is a `roles` change plus a
// `visibleWhen` completion predicate, edited here and nowhere else.
export const launchNav: ReadonlyArray<SettingsNavEntry> = [
  {
    id: "launch",
    group: "setup",
    label: "Launch",
    href: "/settings/launch",
    roles: ["owner", "practitioner"],
    order: 10,
  },
];
