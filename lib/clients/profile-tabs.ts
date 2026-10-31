// Client profile tabs (PB). Pure and client-safe.
//
// The tab VALUE lives in the URL (?tab=), so every value a link could ever have carried keeps
// resolving to a meaningful place. Legacy values are mapped here, on the server, with no redirect:
//   consultation -> treatment (#consultation)   Consultation, assessments and budget sit under Treatment
//   personal     -> notes
//   health, messages, sessions, overview, treatment unchanged
// An unknown value is Overview (today's behaviour). Billing is owner-only: a non-owner asking for it
// lands on Overview and the billing reads are never executed for them (see canViewClientBilling).

export type ProfileTab =
  | "overview"
  | "sessions"
  | "treatment"
  | "photos"
  | "health"
  | "messages"
  | "notes"
  | "billing";

export type ProfileTabViewer = { isOwner: boolean };

const TABS: ReadonlyArray<{ value: ProfileTab; label: string; ownerOnly?: true }> = [
  { value: "overview", label: "Overview" },
  { value: "sessions", label: "Sessions" },
  { value: "treatment", label: "Treatment" },
  { value: "photos", label: "Photos" },
  { value: "health", label: "Health & Forms" },
  { value: "messages", label: "Messages" },
  { value: "notes", label: "Notes" },
  { value: "billing", label: "Billing", ownerOnly: true },
];

// Tabs the viewer may open, in display order. The billing tab is not listed for a non-owner.
export function profileTabsFor(viewer: ProfileTabViewer): ReadonlyArray<{ value: ProfileTab; label: string }> {
  return TABS.filter((t) => !t.ownerOnly || viewer.isOwner).map(({ value, label }) => ({ value, label }));
}

const LEGACY: Readonly<Record<string, { tab: ProfileTab; anchor?: string }>> = {
  consultation: { tab: "treatment", anchor: "consultation" },
  personal: { tab: "notes" },
};

export type ResolvedProfileTab = {
  tab: ProfileTab;
  // Section id inside the tab the old link meant, if any.
  anchor?: string;
  // True when the viewer asked for a tab they may not open (the page lands on Overview instead).
  denied: boolean;
};

export function resolveProfileTab(raw: string | null | undefined, viewer: ProfileTabViewer): ResolvedProfileTab {
  const value = (raw ?? "").trim().toLowerCase();
  if (Object.hasOwn(LEGACY, value)) return { ...LEGACY[value], denied: false };
  const found = TABS.find((t) => t.value === value);
  if (!found) return { tab: "overview", denied: false };
  if (found.ownerOnly && !viewer.isOwner) return { tab: "overview", denied: true };
  return { tab: found.value, denied: false };
}

// ---- billing --------------------------------------------------------------------------------
// Payment method, card authorization, payment history, client pricing and lifetime spend (the header
// figure included) are owner-only. The loader AND every action check this; hiding the tab is not the
// gate. services.price_cents stays readable by every member (0254 decision) and is not billing here.
export function canViewClientBilling(role: string | null | undefined): boolean {
  return role === "owner";
}
