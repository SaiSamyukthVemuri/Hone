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

export const SETTINGS_NAV: ReadonlyArray<SettingsNavEntry> = [
  ...launchNav,
  {
    id: "profile",
    group: "personal",
    label: "Profile",
    href: "/settings/profile",
    roles: BOTH,
    sections: [{ id: "your-name", label: "Personal details" }],
    order: 10,
  },
  ...calendarNav,
  {
    id: "studio",
    group: "studio",
    label: "Studio",
    href: "/settings/studio",
    roles: OWNER,
    sections: [
      { id: "studio-details", label: "Studio details" },
      { id: "email-notifications", label: "Email notifications" },
      { id: "sms-notifications", label: "Text messages" },
      { id: "client-self-service", label: "Client self-service" },
    ],
    order: 10,
  },
  {
    id: "forms",
    group: "studio",
    label: "Forms & Postcare",
    href: "/settings/intake",
    roles: BOTH,
    sections: [
      { id: "postcare", label: "Postcare" },
      { id: "intake-preview", label: "Intake form preview" },
      { id: "policies", label: "Cancellation & no-show policy" },
    ],
    // The postcare and policy editors render for an owner only (the page shows a
    // non-owner just the read-only intake preview).
    sectionRoles: { postcare: OWNER, policies: OWNER },
    order: 20,
  },
  {
    id: "team",
    group: "studio",
    label: "Team",
    href: "/settings/team",
    roles: OWNER,
    sections: [
      { id: "invite-practitioner", label: "Invite a practitioner" },
      { id: "practitioners", label: "Practitioners" },
      { id: "pending-invitations", label: "Pending invitations" },
    ],
    order: 30,
  },
  { id: "booking", group: "studio", label: "Booking", href: "/settings/booking", roles: OWNER, order: 40 },
  {
    id: "waitlist",
    group: "studio",
    label: "Waitlist",
    href: "/settings/waitlist",
    roles: OWNER,
    visibleWhen: waitlistVisible,
    order: 50,
  },
  { id: "availability", group: "studio", label: "Availability", href: "/settings/availability", roles: BOTH, order: 60 },
  { id: "services", group: "studio", label: "Services", href: "/settings/services", roles: OWNER, order: 70 },
  { id: "machines", group: "studio", label: "Machines", href: "/settings/machines", roles: OWNER, order: 80 },
  { id: "consent", group: "studio", label: "Consent forms", href: "/settings/consent", roles: OWNER, order: 90 },
  { id: "payments", group: "studio", label: "Payments", href: "/settings/payments", roles: OWNER, order: 100 },
  { id: "integrations", group: "studio", label: "Integrations", href: "/settings/integrations", roles: OWNER, order: 110 },
  { id: "tracking", group: "studio", label: "Marketing & analytics", href: "/settings/tracking", roles: OWNER, order: 120 },
  { id: "import", group: "studio", label: "Import", href: "/settings/import", roles: OWNER, order: 130 },
  { id: "data", group: "studio", label: "Data", href: "/settings/data", roles: OWNER, order: 140 },
];
