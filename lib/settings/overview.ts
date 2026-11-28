import "server-only";

import {
  NAV_ENTRIES,
  isNavEntryVisible,
  type NavEntry,
  type NavSearchContext,
} from "@/lib/search/navigation-registry";
import type { SettingsNavItem } from "./nav";

const categories = [
  { name: "Booking & availability", ids: ["booking-link", "availability", "booking-window", "studio-client-self-service", "waitlist"] },
  { name: "Messages", ids: ["studio-email", "studio-text-messages", "integrations-sms"] },
  { name: "Payments & fees", ids: ["payments-setup", "payments-card-on-file", "payments-fees"] },
  { name: "Client forms & care", ids: ["consent", "forms-intake-preview", "forms-postcare", "forms-cancellation-policy"] },
  { name: "Studio & team", ids: ["studio-details", "team", "subscription", "calendar-display", "launch"] },
  { name: "Services & machines", ids: ["services", "machines"] },
  { name: "Connections & data", ids: ["integrations-google", "integrations-marketing", "import", "data"] },
  { name: "My profile", ids: ["profile-details", "settings-calendar-feed", "settings-google-calendar-own"] },
];

type OverviewDestination = { label: string; href: string; keywords: string };

export type OverviewSection = {
  name: string;
  links: (OverviewDestination & { controls?: OverviewDestination[] })[];
};

function searchVocabulary(entry: NavEntry) {
  return [entry.title, entry.description, ...entry.keywords].join(" ");
}

export function buildSettingsOverview(
  items: readonly SettingsNavItem[],
  context: NavSearchContext,
): OverviewSection[] {
  const leaves = items.flatMap((item) =>
    item.children.length ? [...item.children] : [{ id: item.id, label: item.label, href: item.href }],
  );
  const visiblePaths = new Set(leaves.map((leaf) => leaf.href));
  const entries = NAV_ENTRIES.filter((entry) =>
    entry.category === "Settings" &&
    visiblePaths.has(entry.href.split("#")[0]) &&
    isNavEntryVisible(entry, context),
  );
  for (const entry of entries) {
    if (entry.id === "settings-calendar-feed" || entry.id === "settings-google-calendar-own") {
      leaves.push({ id: entry.id, label: entry.title, href: entry.href });
    }
  }

  const byHref = new Set(leaves.map((leaf) => leaf.href));
  const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
  const categoriesWithFallback = [...categories, { name: "Other settings", ids: leaves.map((leaf) => leaf.id) }];
  const result: OverviewSection[] = [];
  for (const { name, ids } of categoriesWithFallback) {
    const links: OverviewSection["links"] = [];
    for (const id of ids) {
      const leaf = byId.get(id);
      if (!leaf) continue;
      const keywords = entries.filter((entry) => entry.href === leaf.href).map(searchVocabulary).join(" ");
      const controls = entries
        .filter((entry) => entry.href.startsWith(leaf.href + "#") && !byHref.has(entry.href))
        .map((entry) => ({ label: entry.title, href: entry.href, keywords: searchVocabulary(entry) }));
      links.push({ label: leaf.label, href: leaf.href, keywords, controls });
      byId.delete(id);
    }
    if (links.length) result.push({ name, links });
  }
  return result;
}
