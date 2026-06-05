import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #157. ClientAppointmentTimeline renders the per-client appointment
// history with Chart session / View session / Open appointment
// affordances. The grouping rules, the link shapes, and the cancelled-
// vs-charted precedence are the externally-visible product contract;
// pin them textually so a future refactor that swaps the buckets or
// drops the ?appointment_id forward is caught by `npm test`.

const COMPONENT_PATH = path.resolve(
  __dirname,
  "../../components/client-appointment-timeline.tsx",
);
const SOURCE = readFileSync(COMPONENT_PATH, "utf8");

describe("ClientAppointmentTimeline classification rules", () => {
  it("routes cancelled status to the Cancelled bucket regardless of starts_at", () => {
    expect(SOURCE).toMatch(
      /if \(row\.status === "cancelled"\) return "cancelled";/,
    );
  });

  it("routes no_show status to the No-show bucket regardless of starts_at", () => {
    expect(SOURCE).toMatch(
      /if \(row\.status === "no_show"\) return "noShow";/,
    );
  });

  it("upcoming = confirmed AND starts_at > now", () => {
    // Both predicates must guard the upcoming bucket. Dropping
    // status === 'confirmed' would silently surface completed or
    // no_show rows on the Upcoming row; dropping startMs > nowMs
    // would surface past confirmed rows there.
    expect(SOURCE).toMatch(
      /startMs > nowMs && row\.status === "confirmed"[\s\S]*?return "upcoming";/,
    );
  });

  it("needsCharting = past + (confirmed/completed) + no linked session", () => {
    // The default branch (after cancelled / no_show / upcoming /
    // charted) handles past + uncharted. linked_session presence
    // therefore decides between charted vs needsCharting.
    expect(SOURCE).toMatch(/if \(row\.linked_session\) return "charted";/);
    // The trailing return must be needsCharting (the comment names it).
    expect(SOURCE).toMatch(/return "needsCharting";/);
  });
});

describe("link shapes", () => {
  it("Chart session links to /clients/<clientId>/sessions/new?appointment_id=<row.id>", () => {
    // The exact href shape carries the PR #156 query parameter that
    // startSessionAction validates and stamps. Dropping the
    // ?appointment_id silently degrades the timeline back to client-
    // scoped charting; the test pins the shape.
    expect(SOURCE).toMatch(
      /\/clients\/\$\{clientId\}\/sessions\/new\?appointment_id=\$\{encodeURIComponent\(row\.id\)\}/,
    );
  });

  it("View session links to /clients/<clientId>/sessions/<linkedSession.id>", () => {
    expect(SOURCE).toMatch(
      /\/clients\/\$\{clientId\}\/sessions\/\$\{row\.linked_session\.id\}/,
    );
  });

  it("Open appointment links to /calendar/<row.id>", () => {
    expect(SOURCE).toMatch(/\/calendar\/\$\{row\.id\}/);
  });
});

describe("affordance rules per bucket", () => {
  it("cancelled and noShow do NOT render a Chart session link", () => {
    // The cancelled/noShow branch lives inside one `if` and renders
    // only View session (when linked) + Open appointment.
    const cancelBranch =
      SOURCE.match(
        /if \(bucket === "cancelled" \|\| bucket === "noShow"\)[\s\S]*?\n  \}/,
      )?.[0] ?? "";
    expect(cancelBranch).not.toMatch(/Chart session/);
    expect(cancelBranch).toMatch(/Open appointment/);
  });

  it("upcoming does NOT render a Chart session link (calendar detail is the right place)", () => {
    // The trailing return statement handles upcoming. We pin the
    // JSX block specifically (between `return (` and `);`) so the
    // rationale comment above it, which legitimately mentions
    // "Chart session" while explaining why it is NOT rendered, does
    // not trip the assertion.
    const trail =
      SOURCE.match(
        /\/\/ Upcoming: Open appointment only[\s\S]*?return \(([\s\S]*?)\);\n\}/,
      )?.[1] ?? "";
    expect(trail).not.toMatch(/Chart session/);
    expect(trail).toMatch(/Open appointment/);
  });

  it("needsCharting renders Chart session AS PRIMARY (dark button)", () => {
    const needsBranch =
      SOURCE.match(/if \(bucket === "needsCharting"\)[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(needsBranch).toMatch(/Chart session/);
    expect(needsBranch).toMatch(/bg-neutral-900/);
  });

  it("charted renders View session AS PRIMARY", () => {
    const chartedBranch =
      SOURCE.match(
        /if \(bucket === "charted" && row\.linked_session\)[\s\S]*?\n  \}/,
      )?.[0] ?? "";
    expect(chartedBranch).toMatch(/View session/);
    expect(chartedBranch).toMatch(/bg-neutral-900/);
  });
});

describe("cancelled metadata rendering", () => {
  it("renders cancelled_at and cancellation_reason when present", () => {
    expect(SOURCE).toMatch(/Cancelled <FormattedDateTime iso=\{cancelledAt\}/);
    expect(SOURCE).toMatch(/Reason: \{reason\}/);
  });

  it("safely renders nothing when cancelled_at and reason are both null", () => {
    expect(SOURCE).toMatch(/if \(!cancelledAt && !reason\) return null;/);
  });
});

describe("date/time formatting goes through <FormattedDateTime>", () => {
  it("uses the shared component for the starts_at row label", () => {
    // The shared component picks up AM/PM via Intl.DateTimeFormat
    // with hour: "numeric" + minute: "2-digit" in the user's locale.
    expect(SOURCE).toMatch(/<FormattedDateTime iso=\{row\.starts_at\}/);
  });

  it("uses format=\"time\" for the trailing ends_at portion of the row", () => {
    expect(SOURCE).toMatch(
      /<FormattedDateTime iso=\{row\.ends_at\} format="time"/,
    );
  });
});

describe("no service-role / admin client in the component", () => {
  it("does not import the Supabase admin client", () => {
    expect(SOURCE).not.toMatch(/admin-server|createAdminClient/);
  });
});

// ---------------------------------------------------------------------------
// Client profile page wires the component into the Sessions tab.
// ---------------------------------------------------------------------------

const PAGE_PATH = path.resolve(
  __dirname,
  "../../app/(app)/clients/[id]/page.tsx",
);
const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");

describe("client profile Sessions tab embeds the appointment timeline", () => {
  it("imports ClientAppointmentTimeline", () => {
    expect(PAGE_SOURCE).toMatch(
      /import \{ ClientAppointmentTimeline \} from "@\/components\/client-appointment-timeline"/,
    );
  });

  it("calls getAppointmentsForClientProfile with the resolved studio + client ids", () => {
    expect(PAGE_SOURCE).toMatch(
      /getAppointmentsForClientProfile\(\s*studio\.id,\s*client\.id,?\s*\)/,
    );
  });

  it("renders <ClientAppointmentTimeline> with the rows + client id", () => {
    expect(PAGE_SOURCE).toMatch(
      /<ClientAppointmentTimeline[\s\S]*?clientId=\{client\.id\}[\s\S]*?rows=\{appointmentTimeline\}/,
    );
  });

  it("no longer renders the legacy 'Visits awaiting charting' section", () => {
    expect(PAGE_SOURCE).not.toMatch(/Visits awaiting charting/);
  });

  it("top-level + Log session button carries the secondary-path helper text", () => {
    // The button stays for walk-in / off-book session logging; the
    // helper copy makes that explicit so the practitioner does not
    // reach for it on a booked appointment.
    expect(PAGE_SOURCE).toMatch(
      /For a session that is not tied to a booked appointment\./,
    );
  });
});
