import { createClient } from "@/lib/supabase/server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { getActiveServices } from "@/lib/booking/queries";
import {
  CONSENT_SETTINGS_HREF,
  getTreatmentConsentReadiness,
} from "@/lib/consent/launch-readiness";
import { hasAnyReaction } from "@/lib/sessions/reaction-unified";

// PR #215: Getting Started / onboarding checklist. A practical setup
// and readiness checklist (not a product tour): auto-detected status
// where existing data can prove a step happened, and static "Review"
// guidance where it cannot. No migration: V1 deliberately has no
// manual mark-as-done persistence (storing it would need a new
// table/column; documented decision). Read-only; pilot wording only
// (payments section is runtime-mode aware; record-keeping support,
// not compliance).

export type ChecklistStatus = "done" | "todo" | "review";

export type ChecklistItem = {
  key: string;
  label: string;
  explanation: string;
  status: ChecklistStatus;
  href: string | null;
};

export type ChecklistSection = {
  key: string;
  title: string;
  items: ChecklistItem[];
};

export type GettingStarted = {
  sections: ChecklistSection[];
  // Progress counts AUTO-DETECTED items only (done/todo); "review"
  // guidance items are excluded so the number is honest.
  autoDone: number;
  autoTotal: number;
};

export type GettingStartedSignals = {
  studioName: string;
  practitionerName: string;
  hasSlug: boolean;
  activeServices: number;
  appointments: number;
  clients: number;
  sessions: number;
  treatmentAreas: number;
  hasFrequency: boolean;
  hasProbe: boolean;
  hasProbeLot: boolean;
  hasReactionOrTolerance: boolean;
  hasNextVisitNote: boolean;
  // F-CONSENT-GAP. Tri-state on purpose: true / false are facts, `null` means
  // the readiness read failed. Collapsing null to false would tell an owner to
  // create a consent form they already have. Derived by the ONE authority,
  // lib/consent/launch-readiness.ts.
  liveTreatmentConsent: boolean | null;
  sterileItems: number;
  disinfectants: number;
  // CURRENT-mode payment attempt count (scoped by inferStripeLivemode();
  // pre-PR-A this was an unscoped count, so a live attempt ticked the
  // "test-mode payments" item).
  paymentAttempts: number;
  runtimeLivemode: boolean;
};

function auto(
  key: string,
  label: string,
  explanation: string,
  done: boolean,
  href: string | null,
): ChecklistItem {
  return { key, label, explanation, status: done ? "done" : "todo", href };
}

function review(
  key: string,
  label: string,
  explanation: string,
  href: string | null,
): ChecklistItem {
  return { key, label, explanation, status: "review", href };
}

/**
 * THE NEXT SETUP TASK, or null when there is nothing left to point at.
 *
 * WHY THIS EXISTS. The checklist was a STATUS DISPLAY, not a flow: every item
 * carries an `href` INTO its own task and nothing carries a pointer onward, so
 * finishing one task returned the operator to the settings page they had just
 * used and left them to re-derive what to do next. Pilot feedback named this
 * directly ("finishing one task should lead directly to the next setup task").
 *
 * IT INVENTS NO ORDER. `buildGettingStarted` already emits sections and items
 * in a deliberate sequence (basics -> booking -> charting -> records -> daily
 * -> payments); this walks that existing order and returns the first item an
 * operator can actually act on. A second ordering here would be a competing
 * authority, which is the failure this repository keeps re-learning.
 *
 * TWO EXCLUSIONS, both deliberate:
 *
 *   `review` items are guidance to read once, not detectable work. They are
 *   already excluded from `autoDone`/`autoTotal`, and pointing "next" at one
 *   would stall the chain on something completion can never clear.
 *
 *   `href === null` items are not navigable. An item can be genuinely
 *   incomplete and have nowhere to send you (the consent read failing, for
 *   instance); offering a dead CTA is worse than offering none.
 *
 * A `todo` item with no href therefore does NOT block the chain — the walk
 * continues past it. The checklist below still shows it as outstanding, so it
 * is surfaced, just not as the next click.
 */
/**
 * MAY THIS CHECKLIST CLAIM TO KNOW WHAT COMES NEXT?
 *
 * THERE ARE TWO ONBOARDING ORDERS IN THIS REPOSITORY, and only one of them
 * governs a given studio:
 *
 *   this legacy checklist   basics -> booking -> charting -> records ->
 *                           daily -> payments
 *   ONBOARDING_STEP_ORDER   welcome -> service -> availability -> booking ->
 *   (lib/onboarding/steps)  payments -> done
 *
 * The dashboard hands onboarding to the v2 wizard for an owner whose studio has
 * `onboarding_v2_enabled`. `/getting-started` stays reachable regardless — via
 * AccountMenu, MobileMenu and search — so without this gate it would answer
 * "what is next?" from the LEGACY order while the studio's actual onboarding
 * ran the v2 one. Two authorities, two different answers, and the operator has
 * no way to tell which is lying.
 *
 * So the CTA is suppressed exactly where v2 owns the flow. The checklist itself
 * still renders: it remains a useful readiness view, and a status display that
 * claims no sequence cannot contradict one.
 *
 * MIRRORS THE DASHBOARD'S OWN PREDICATE (`isOwner && onboarding_v2_enabled ===
 * true`) rather than inventing a second reading of the flag, and treats an
 * absent column as "not enabled" because the type is optional for schema-skew
 * tolerance — failing toward the legacy flow, which is what a studio without
 * the column is actually on.
 */
export function legacyChecklistMayOfferNextStep(opts: {
  isOwner: boolean;
  onboardingV2Enabled?: boolean | null;
}): boolean {
  return !(opts.isOwner && opts.onboardingV2Enabled === true);
}

export function nextSetupStep(checklist: GettingStarted): ChecklistItem | null {
  for (const section of checklist.sections) {
    for (const item of section.items) {
      if (item.status !== "todo") continue;
      if (item.href === null) continue;
      return item;
    }
  }
  return null;
}

export function buildGettingStarted(
  s: GettingStartedSignals,
): GettingStarted {
  const sections: ChecklistSection[] = [
    {
      key: "basics",
      title: "Studio basics",
      items: [
        auto(
          "studio-profile",
          "Studio profile exists",
          `Your studio (${s.studioName}) is set up.`,
          s.studioName.trim().length > 0,
          "/settings/profile",
        ),
        auto(
          "practitioner-profile",
          "Practitioner profile exists",
          "Your name shows on sessions and records.",
          s.practitionerName.trim().length > 0,
          "/settings/profile",
        ),
        auto(
          "services",
          "Services created",
          "Clients book from your service menu.",
          s.activeServices > 0,
          "/settings/launch",
        ),
        auto(
          "booking-page",
          "Booking page available",
          "Your public booking link needs a studio URL and at least one service.",
          s.hasSlug && s.activeServices > 0,
          "/settings/launch",
        ),
      ],
    },
    {
      key: "booking",
      title: "Booking and intake",
      items: [
        auto(
          "test-booking",
          "Test booking created",
          "Book a test appointment to see the client experience.",
          s.appointments > 0,
          "/calendar",
        ),
        review(
          "intake-review",
          "Intake form reviewed",
          "Open a test intake and check the questions fit your practice.",
          "/clients",
        ),
        // F-CONSENT-GAP. Auto-detected from the SAME rule the launch checklist
        // uses (lib/consent/launch-readiness.ts); this file never re-derives
        // it. `null` means the read failed, which is a "review" item rather
        // than a "todo": an unreadable count must not be reported as an
        // authoritative absence. A live template means the intake has a form
        // to present; it is not a claim about legal enforceability.
        s.liveTreatmentConsent === null
          ? review(
              "treatment-consent",
              "Treatment consent form",
              "Couldn't check your consent forms just now. Open Consent forms to confirm one is live.",
              CONSENT_SETTINGS_HREF,
            )
          : auto(
              "treatment-consent",
              "Treatment consent form is live",
              "Without a live treatment consent form, the intake asks new clients for no consent.",
              s.liveTreatmentConsent,
              CONSENT_SETTINGS_HREF,
            ),
        review(
          "emails-review",
          "Confirmation/reminder emails reviewed",
          "Check the wording on a test booking's confirmation and reminders.",
          "/settings/launch",
        ),
      ],
    },
    {
      key: "charting",
      title: "Charting workflow",
      items: [
        auto(
          "test-client",
          "Create a test client",
          "A practice client keeps real records clean.",
          s.clients > 0,
          "/clients",
        ),
        auto(
          "test-session",
          "Add a test session",
          "Log a session from the client profile.",
          s.sessions > 0,
          "/clients",
        ),
        auto(
          "treatment-area",
          "Add a treatment area",
          "Charting is per treatment area.",
          s.treatmentAreas > 0,
          "/clients",
        ),
        auto(
          "frequency",
          "Record machine frequency",
          "Sticky: your last-used frequency pre-fills new areas.",
          s.hasFrequency,
          "/clients",
        ),
        auto(
          "probe",
          "Record probe",
          "Pick the probe from the catalog.",
          s.hasProbe,
          "/clients",
        ),
        auto(
          "probe-lot",
          "Record probe lot/batch number",
          "Feeds procedure records and lot traceability.",
          s.hasProbeLot,
          "/clients",
        ),
        auto(
          "reaction-tolerance",
          "Add reaction/tolerance",
          "Builds the client's treatment memory.",
          s.hasReactionOrTolerance,
          "/clients",
        ),
        auto(
          "next-visit",
          "Add a For next visit note",
          "Shows in Before today at the next appointment.",
          s.hasNextVisitNote,
          "/clients",
        ),
      ],
    },
    {
      key: "records",
      title: "Record Keeping",
      items: [
        auto(
          "sterile-item",
          "Add at least one Sterile Item record",
          "Record purchased probe boxes with lot and expiry.",
          s.sterileItems > 0,
          "/records?section=sterile",
        ),
        auto(
          "disinfectant",
          "Add at least one Disinfectant record",
          "Record prepared disinfectants and discard dates.",
          s.disinfectants > 0,
          "/records?section=disinfectants",
        ),
        review(
          "exposure-review",
          "Review the Exposure Incident log",
          "Know where to record an accidental exposure.",
          "/records?section=incidents",
        ),
        review(
          "procedure-review",
          "Review Client Procedure Records",
          "Generated from your sessions; gaps show as Not recorded.",
          "/records?section=procedures",
        ),
        review(
          "print-test",
          "Test Print / Export",
          "Open a section and print or save as PDF.",
          "/records/print?section=sterile",
        ),
        review(
          "trace-test",
          "Test Lot Traceability",
          "Trace a lot number to see where it was used.",
          "/records?section=sterile",
        ),
      ],
    },
    {
      key: "daily",
      title: "Daily workflow",
      items: [
        review(
          "daily-dashboard",
          "Review the Dashboard",
          "Appointments, service value, and action items.",
          "/dashboard",
        ),
        review(
          "daily-today",
          "Review Today appointments",
          "Each row carries a Before today preview.",
          "/dashboard",
        ),
        review(
          "daily-before-today",
          "Open the full Before today card",
          "On the client Overview before starting a client.",
          "/clients",
        ),
        review(
          "daily-intelligence",
          "Review Treatment Intelligence",
          "Recorded treatment history per client.",
          "/clients",
        ),
        review(
          "daily-attention",
          "Check Clients needing attention",
          "Recorded watch notes and next-visit plans.",
          "/dashboard",
        ),
      ],
    },
    {
      key: "payments",
      title: "Payments",
      // State-driven (PR A): the pre-live static claims ("Live payments are
      // off", "Legal review pending", "Willow checklist pending") were false
      // once live billing shipped. Mode comes from the deployment runtime;
      // the attempts count is CURRENT-mode scoped.
      items: [
        auto(
          s.runtimeLivemode ? "payments-used" : "test-payments",
          s.runtimeLivemode
            ? "Payments available (live)"
            : "Test-mode payments available",
          s.runtimeLivemode
            ? "Prepare and run charges from a session against a saved, authorized card."
            : "Prepare and run test charges from a session.",
          s.paymentAttempts > 0,
          null,
        ),
        // Live runtime: a done auto item. Test runtime: an informational
        // review item (an environment fact, not a completable task: it
        // must not sit as an eternal todo or skew auto progress).
        s.runtimeLivemode
          ? auto(
              "payment-mode",
              "Live payments enabled",
              "This deployment runs in Stripe live mode. Studio readiness is shown in Settings \u2192 Payments.",
              true,
              "/settings/payments",
            )
          : review(
              "payment-mode",
              "Live payments are off in this environment",
              "This environment runs in Stripe test mode. No real cards can be charged here.",
              "/settings/payments",
            ),
        auto(
          "legal-approved",
          "Legal/accounting review",
          "Lawyer-approved payment copy is live (receipts and card authorization).",
          true,
          null,
        ),
        auto(
          "stripe-connect",
          "Stripe Connect (per studio)",
          "Connect status, payouts, and live/test readiness are shown in Settings \u2192 Payments.",
          true,
          "/settings/payments",
        ),
      ],
    },
  ];

  const autoItems = sections.flatMap((sec) =>
    sec.items.filter((i) => i.status !== "review"),
  );
  return {
    sections,
    autoDone: autoItems.filter((i) => i.status === "done").length,
    autoTotal: autoItems.length,
  };
}

export async function getGettingStartedSignals(
  studio: { id: string; name: string; slug: string | null },
  practitionerName: string,
): Promise<GettingStartedSignals> {
  const supabase = await createClient();
  const count = (table: string) =>
    supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studio.id);

  const [
    services,
    appointments,
    clients,
    sterile,
    disinfectants,
    payments,
    // One bounded existence read, in the SAME Promise.all as everything else:
    // no additional round trip and no per-item query.
    treatmentConsent,
    { data: blockRows },
    { data: noteRows },
  ] = await Promise.all([
    getActiveServices(studio.id),
    count("appointments"),
    count("clients"),
    count("record_keeping_sterile_items"),
    count("record_keeping_disinfectants"),
    supabase
      .from("payment_charge_attempts")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studio.id)
      .eq("stripe_livemode", inferStripeLivemode()),
    getTreatmentConsentReadiness(studio.id),
    supabase
      .from("session_blocks")
      // Charting unification: reactions may live as chips in the block's live
      // entries' observation_chips; embed them so the completeness check reads
      // the unified representation.
      .select(
        "machine_frequency, probe_label, probe_key, probe_lot_number, reaction_type, tolerance_rating, electrolysis_entries(observation_chips, deleted_at)",
      )
      .eq("studio_id", studio.id)
      .is("deleted_at", null)
      .limit(500),
    supabase
      .from("sessions")
      .select("id, next_session_note")
      .eq("studio_id", studio.id)
      .is("deleted_at", null)
      .order("started_at", { ascending: false })
      .limit(200),
  ]);

  const blocks = (blockRows ?? []) as Array<{
    machine_frequency: string | null;
    probe_label: string | null;
    probe_key: string | null;
    probe_lot_number: string | null;
    reaction_type: string | null;
    tolerance_rating: number | null;
    electrolysis_entries?:
      | Array<{ observation_chips: unknown; deleted_at: string | null }>
      | null;
  }>;
  const notes = (noteRows ?? []) as Array<{
    next_session_note: string | null;
  }>;

  return {
    studioName: studio.name,
    practitionerName,
    hasSlug: !!studio.slug,
    activeServices: services.length,
    appointments: appointments.count ?? 0,
    clients: clients.count ?? 0,
    sessions: notes.length,
    treatmentAreas: blocks.length,
    hasFrequency: blocks.some((b) => !!b.machine_frequency),
    hasProbe: blocks.some((b) => !!b.probe_label || !!b.probe_key),
    hasProbeLot: blocks.some((b) => !!b.probe_lot_number?.trim()),
    hasReactionOrTolerance: blocks.some(
      (b) =>
        hasAnyReaction(
          b.reaction_type,
          (b.electrolysis_entries ?? [])
            .filter((e) => e.deleted_at == null)
            .map((e) => e.observation_chips),
        ) || b.tolerance_rating != null,
    ),
    hasNextVisitNote: notes.some((n) => !!n.next_session_note?.trim()),
    // `null` preserves "could not establish" all the way to the item; it is
    // never coerced to false here.
    liveTreatmentConsent: treatmentConsent.ok ? treatmentConsent.ready : null,
    sterileItems: sterile.count ?? 0,
    disinfectants: disinfectants.count ?? 0,
    paymentAttempts: payments.count ?? 0,
    runtimeLivemode: inferStripeLivemode(),
  };
}
