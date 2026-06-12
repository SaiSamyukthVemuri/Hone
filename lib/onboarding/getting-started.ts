import { createClient } from "@/lib/supabase/server";
import { getActiveServices } from "@/lib/booking/queries";

// PR #215: Getting Started / onboarding checklist. A practical setup
// and readiness checklist (not a product tour): auto-detected status
// where existing data can prove a step happened, and static "Review"
// guidance where it cannot. No migration: V1 deliberately has no
// manual mark-as-done persistence (storing it would need a new
// table/column; documented decision). Read-only; pilot wording only
// (live payments stay off; record-keeping support, not compliance).

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
  sterileItems: number;
  disinfectants: number;
  testPaymentAttempts: number;
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
      items: [
        auto(
          "test-payments",
          "Test-mode payments available",
          "Prepare and run test charges from a session.",
          s.testPaymentAttempts > 0,
          null,
        ),
        review(
          "live-off",
          "Live payments are off",
          "No real cards can be charged. Collected revenue is not enabled yet.",
          null,
        ),
        review(
          "legal-pending",
          "Legal/accounting review pending",
          "Required before live payments can be considered.",
          null,
        ),
        review(
          "stripe-checklist-pending",
          "Willow Stripe live checklist pending",
          "Payouts, live webhook, and statement descriptor still need review.",
          null,
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
    { data: blockRows },
    { data: noteRows },
  ] = await Promise.all([
    getActiveServices(studio.id),
    count("appointments"),
    count("clients"),
    count("record_keeping_sterile_items"),
    count("record_keeping_disinfectants"),
    count("payment_charge_attempts"),
    supabase
      .from("session_blocks")
      .select(
        "machine_frequency, probe_label, probe_key, probe_lot_number, reaction_type, tolerance_rating",
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
      (b) => !!b.reaction_type || b.tolerance_rating != null,
    ),
    hasNextVisitNote: notes.some((n) => !!n.next_session_note?.trim()),
    sterileItems: sterile.count ?? 0,
    disinfectants: disinfectants.count ?? 0,
    testPaymentAttempts: payments.count ?? 0,
  };
}
