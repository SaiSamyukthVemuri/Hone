// Settings navigation model (settings redesign, WS-B).
//
// ONE place that says which settings pages exist, where they sit in the rail,
// and who may see them. The settings layout evaluates it on the SERVER and hands
// the browser only the entries the signed-in role may see, so an owner-only
// entry is never shipped to a practitioner (same posture as the search
// registry). Hiding an entry is NAVIGATION, never access: every page keeps its
// own server-side gate.
//
// Workstreams add their own entries from their own folder (for example
// app/(app)/settings/calendar/nav.ts) and the shell registry imports that file;
// nothing in a page folder needs to edit the layout.

import type { Studio } from "@/lib/types/database";

export type SettingsRole = "owner" | "practitioner";

export type SettingsNavGroup = "setup" | "personal" | "studio";

export type SettingsNavSection = {
  /** Right-pane section id: the URL fragment and the element id on the page. */
  id: string;
  label: string;
};

export type SettingsNavContext = {
  role: SettingsRole;
  /** The server-resolved studio (never anything the browser sent). */
  studio: Studio;
};

export type SettingsNavEntry = {
  /** Stable id, e.g. "studio". */
  id: string;
  group: SettingsNavGroup;
  label: string;
  /** One route per entry; subsections are anchors on it. */
  href: string;
  sections?: ReadonlyArray<SettingsNavSection>;
  /** Static allow-list, evaluated on the server. */
  roles: ReadonlyArray<SettingsRole>;
  /**
   * Per-section role overrides. A section listed here is shown only to those
   * roles; a section not listed inherits the entry's roles.
   */
  sectionRoles?: Readonly<Record<string, ReadonlyArray<SettingsRole>>>;
  /**
   * Extra server-side condition (a flag, a completion state, a queue). It runs
   * only for a role the static list already admits.
   */
  visibleWhen?: (ctx: SettingsNavContext) => boolean | Promise<boolean>;
  /** Sort key inside the group; ties keep registry order. */
  order: number;
};

/** What the browser receives: serialisable, already filtered for the role. */
export type SettingsNavItem = {
  id: string;
  group: SettingsNavGroup;
  label: string;
  href: string;
  sections: ReadonlyArray<SettingsNavSection>;
};

export const SETTINGS_NAV_GROUP_LABEL: Readonly<Record<SettingsNavGroup, string | null>> = {
  setup: null,
  personal: "PERSONAL",
  studio: "STUDIO",
};

export const SETTINGS_NAV_GROUP_ORDER: ReadonlyArray<SettingsNavGroup> = [
  "setup",
  "personal",
  "studio",
];

/**
 * Filter the registry for one role, on the server. A `visibleWhen` that throws
 * HIDES the entry (fail closed): a flag read that fails must never widen what
 * is shown.
 */
export async function resolveSettingsNav(
  entries: ReadonlyArray<SettingsNavEntry>,
  ctx: SettingsNavContext,
): Promise<SettingsNavItem[]> {
  const visible: SettingsNavEntry[] = [];
  for (const entry of entries) {
    if (!entry.roles.includes(ctx.role)) continue;
    if (entry.visibleWhen) {
      let ok = false;
      try {
        ok = await entry.visibleWhen(ctx);
      } catch {
        ok = false;
      }
      if (!ok) continue;
    }
    visible.push(entry);
  }
  const groupRank = (g: SettingsNavGroup) => SETTINGS_NAV_GROUP_ORDER.indexOf(g);
  return visible
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        groupRank(a.entry.group) - groupRank(b.entry.group) ||
        a.entry.order - b.entry.order ||
        a.index - b.index,
    )
    .map(({ entry }) => ({
      id: entry.id,
      group: entry.group,
      label: entry.label,
      href: entry.href,
      sections: (entry.sections ?? []).filter((s) => {
        const only = entry.sectionRoles?.[s.id];
        return !only || only.includes(ctx.role);
      }),
    }));
}

/**
 * True when a click landed on (or inside) a link of the rail. The narrow-screen
 * drawer closes on any such click: a same-page section link changes only the
 * URL hash, so the pathname-change effect never fires and the drawer would stay
 * open over the section the user just chose.
 */
export function isRailLinkClick(target: { closest?: (selector: string) => unknown } | null): boolean {
  return Boolean(target?.closest?.("a[href]"));
}

/**
 * The rail item that owns a pathname: exact match first, then the longest
 * prefix (so /settings/payments/return is still "Payments").
 */
export function activeSettingsItem<T extends { href: string }>(
  items: ReadonlyArray<T>,
  pathname: string,
): T | null {
  const exact = items.find((i) => i.href === pathname);
  if (exact) return exact;
  const prefixed = items
    .filter((i) => pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return prefixed ?? null;
}
