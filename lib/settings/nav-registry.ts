import "server-only";

import { launchNav } from "@/app/(app)/settings/launch/nav";
import { calendarNav } from "@/app/(app)/settings/calendar/nav";
import { getNewClientAdmissionMode } from "@/lib/booking/new-client-admission";
import { newClientWaitlistCommitIsDurable } from "@/lib/booking/new-client-waitlist-durability-bridge";
import { createClient } from "@/lib/supabase/server";
import { hasActiveWaitlistEntries } from "@/lib/waitlist/operator-queue-presence";
import type { SettingsNavEntry } from "./nav";

// The Settings rail registry (settings redesign, WS-B owns this file).
//
// Other workstreams contribute from their own folders: Willow's Calendar entry
// is app/(app)/settings/calendar/nav.ts, Team's Launch entry is
// app/(app)/settings/launch/nav.ts. A page that moves or gains a section edits
// its own nav file; nothing outside this registry reaches into the layout.

const BOTH = ["owner", "practitioner"] as const;
const OWNER = ["owner"] as const;

/**
 * WAIT-02 / WAITLIST-NAV-VIS-01 (moved here unchanged from the layout).
 *
 * The durable waitlist tab appears for an owner whose studio is BOTH
 * waitlisting new clients AND recording those requests durably, OR whose studio
 * already holds an entry the operator can still act on. A studio with a real
 * queue must never lose its navigation to that queue because a rollout flag is
 * off. The presence read runs only for an owner, only when the flags have not
 * already answered, on the RLS-scoped user client, HEAD-only, and fails closed
 * (tab hidden). /settings/waitlist stays reachable by URL for an owner either
 * way: this governs navigation, not access. The first half is the DURABLE
 * COMMIT PATH, not the mode (see the bridge): a WAITLIST mode whose joins still
 * commit through legacy email acceptance would open an empty queue.
 */
const waitlistVisible: NonNullable<SettingsNavEntry["visibleWhen"]> = async (ctx) => {
  if (ctx.role !== "owner") return false;
  const admission = await getNewClientAdmissionMode(ctx.studio);
  const waitlistLive = newClientWaitlistCommitIsDurable(admission, ctx.studio.slug);
  return (
    waitlistLive ||
    (await hasActiveWaitlistEntries(await createClient(), ctx.studio.id))
  );
};

// Groups open one focused view each (R2): every child is its OWN route, entered
// at its heading, with no anchors into a longer page. Flat entries have no
// dropdown because they have no meaningful subsections. Old URLs and hashes are
// redirected by lib/settings/redirects.ts and the thin group-index pages.
export const SETTINGS_NAV: ReadonlyArray<SettingsNavEntry> = [
  ...launchNav,
  {
    id: "profile",
    group: "personal",
    label: "Profile",
    href: "/settings/profile",
    roles: BOTH,
    children: [{ id: "profile-details", label: "Personal details", href: "/settings/profile" }],
    order: 10,
  },
  ...calendarNav,
  {
    id: "studio",
    group: "studio",
    label: "Studio",
    href: "/settings/studio",
    roles: OWNER,
    children: [
      { id: "studio-details", label: "Details", href: "/settings/studio/details" },
      { id: "studio-email", label: "Email notifications", href: "/settings/studio/email" },
      { id: "studio-text-messages", label: "Text-message preferences", href: "/settings/studio/text-messages" },
      { id: "studio-client-self-service", label: "Client self-service", href: "/settings/studio/client-self-service" },
    ],
    order: 10,
  },
  {
    id: "forms",
    group: "studio",
    label: "Forms & postcare",
    href: "/settings/forms",
    roles: BOTH,
    children: [
      // The postcare and policy editors render for an owner only; a practitioner
      // keeps the read-only intake preview.
      { id: "forms-postcare", label: "Postcare", href: "/settings/forms/postcare", roles: OWNER },
      { id: "forms-intake-preview", label: "Intake form preview", href: "/settings/forms/intake-preview" },
      { id: "forms-cancellation-policy", label: "Cancellation policy", href: "/settings/forms/cancellation-policy", roles: OWNER },
    ],
    order: 20,
  },
  { id: "team", group: "studio", label: "Team", href: "/settings/team", roles: OWNER, order: 30 },
  {
    id: "booking",
    group: "studio",
    label: "Booking",
    href: "/settings/booking",
    roles: OWNER,
    children: [
      { id: "booking-link", label: "Booking link", href: "/settings/booking/link" },
      { id: "booking-window", label: "Booking window", href: "/settings/booking/window" },
    ],
    order: 40,
  },
  {
    id: "waitlist",
    group: "studio",
    label: "Waitlist",
    href: "/settings/waitlist",
    roles: OWNER,
    visibleWhen: waitlistVisible,
    order: 50,
  },
  { id: "availability", group: "studio", label: "Availability", href: "/settings/availability", roles: OWNER, order: 60 },
  { id: "services", group: "studio", label: "Services", href: "/settings/services", roles: OWNER, order: 70 },
  { id: "machines", group: "studio", label: "Machines", href: "/settings/machines", roles: OWNER, order: 80 },
  { id: "consent", group: "studio", label: "Consent forms", href: "/settings/consent", roles: OWNER, order: 90 },
  {
    id: "payments",
    group: "studio",
    label: "Payments",
    href: "/settings/payments",
    roles: OWNER,
    children: [
      { id: "payments-setup", label: "Payment setup", href: "/settings/payments/setup" },
      { id: "payments-card-on-file", label: "Card-on-file readiness", href: "/settings/payments/card-on-file" },
      { id: "payments-fees", label: "Cancellation & no-show fees", href: "/settings/payments/fees" },
    ],
    order: 100,
  },
  {
    id: "integrations",
    group: "studio",
    label: "Integrations",
    href: "/settings/integrations",
    roles: OWNER,
    children: [
      { id: "integrations-google", label: "Google Calendar", href: "/settings/integrations/google-calendar" },
      { id: "integrations-sms", label: "Text-message setup", href: "/settings/integrations/text-messaging" },
      { id: "integrations-marketing", label: "Marketing & analytics", href: "/settings/integrations/marketing" },
    ],
    order: 110,
  },
  { id: "import", group: "studio", label: "Import", href: "/settings/import", roles: OWNER, order: 130 },
  { id: "data", group: "studio", label: "Data", href: "/settings/data", roles: OWNER, order: 140 },
];
