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

/**
 * One focused view under a group: its OWN route, shown by itself. There are no
 * anchors into a longer page (R2): choosing an item opens that route at its
 * heading.
 */
export type SettingsNavChild = {
  /** Stable id, e.g. "studio-email". */
  id: string;
  label: string;
  href: string;
  /** Static allow-list; absent means the entry's roles. */
  roles?: ReadonlyArray<SettingsRole>;
  /** Extra server-side condition; runs only for an admitted role, fails closed. */
  visibleWhen?: (ctx: SettingsNavContext) => boolean | Promise<boolean>;
};

/** What the browser receives for a child: serialisable, already filtered. */
export type SettingsNavChildItem = Pick<SettingsNavChild, "id" | "label" | "href">;

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
  /**
   * A flat entry's own route. For a group (an entry with `children`) it is only
   * a fallback: the browser receives the first visible child's route instead.
   */
  href: string;
  /** Present for a group: each child is its own route. Absent for a flat link. */
  children?: ReadonlyArray<SettingsNavChild>;
  /** Static allow-list, evaluated on the server. */
  roles: ReadonlyArray<SettingsRole>;
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
  /** Flat link: its route. Group: the first visible child's route. */
  href: string;
  /** The route prefix the entry owns (so /settings/payments/return keeps Payments lit). */
  base: string;
  /** Empty for a flat link; the visible focused views for a group. */
  children: ReadonlyArray<SettingsNavChildItem>;
};

// The approved settings artifact heads the rail with PERSONAL and STUDIO
// (Sam's decision 5, 1 Nov). They are non-clickable category headings, distinct
// from the items beneath. The repetition Sam reported ("Studio > Studio > Studio
// details") is resolved by naming: a group's items carry their own names, and
// each studio view states its scope ("Applies to the whole studio."). The setup
// group (Launch) has no heading.
export const SETTINGS_NAV_GROUP_LABEL: Readonly<Record<SettingsNavGroup, string | null>> = {
  setup: null,
  personal: "Personal",
  studio: "Studio",
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
  const ordered = visible
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        groupRank(a.entry.group) - groupRank(b.entry.group) ||
        a.entry.order - b.entry.order ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
  const items: SettingsNavItem[] = [];
  for (const entry of ordered) {
    if (!entry.children) {
      items.push({ id: entry.id, group: entry.group, label: entry.label, href: entry.href, base: entry.href, children: [] });
      continue;
    }
    const children: SettingsNavChildItem[] = [];
    for (const child of entry.children) {
      if (child.roles && !child.roles.includes(ctx.role)) continue;
      if (child.visibleWhen) {
        let ok = false;
        try {
          ok = await child.visibleWhen(ctx);
        } catch {
          ok = false;
        }
        if (!ok) continue;
      }
      children.push({ id: child.id, label: child.label, href: child.href });
    }
    // A group with no visible child has nothing to open: hide it.
    if (children.length === 0) continue;
    items.push({ id: entry.id, group: entry.group, label: entry.label, href: children[0].href, base: entry.href, children });
  }
  return items;
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
 * Where a pathname sits in the rail: the group or flat entry that owns it and,
 * for a group, the child view. A child matches its exact route first, then the
 * longest child route that prefixes it (so /settings/payments/return keeps
 * "Payments" lit). A flat entry matches the same way on its own route.
 */
export function activeSettingsLocation<
  T extends { href: string; base: string; children: ReadonlyArray<{ href: string }> },
>(
  items: ReadonlyArray<T>,
  pathname: string,
): { item: T; child: T["children"][number] | null } | null {
  type C = T["children"][number];
  type Candidate = { item: T; child: C | null; href: string };
  const candidates: Candidate[] = [];
  for (const item of items) {
    if (item.children.length === 0) candidates.push({ item, child: null, href: item.href });
    for (const child of item.children) candidates.push({ item, child, href: child.href });
  }
  const exact = candidates.find((c) => c.href === pathname);
  if (exact) return { item: exact.item, child: exact.child };
  const prefixed = candidates
    .filter((c) => pathname.startsWith(`${c.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  if (prefixed) return { item: prefixed.item, child: prefixed.child };
  // A route under a group's base that is not one of its views (a return URL).
  const owner = items
    .filter((i) => pathname === i.base || pathname.startsWith(`${i.base}/`))
    .sort((a, b) => b.base.length - a.base.length)[0];
  return owner ? { item: owner, child: null } : null;
}
