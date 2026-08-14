import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildCancellationEmail,
  cancellationActorRoleLabel,
  cancellationActorSummary,
  type CancellationActorRole,
} from "@/lib/email/templates/appointment";

// Cancellation email must make the ACTOR explicit on the practitioner-facing
// email: "Cancelled by: <name> (<Client|Practitioner|Studio owner|System>)",
// plus Client / Original time / Service+duration / Reason, and a clearer subject.
// The actor is derived server-side at each cancellation path (see the wiring guard
// at the bottom); these tests pin the rendering + fallbacks for every role.

const TZ = "America/Toronto";
// 1:30 PM in Toronto (EDT, UTC-4) on July 21, 2026.
const STARTS = new Date("2026-07-21T17:30:00Z");

function studioFacing(
  overrides: Partial<Parameters<typeof buildCancellationEmail>[0]> = {},
) {
  return buildCancellationEmail({
    recipientName: "Willow Electrolysis",
    clientName: "Chloe Vemuri LE",
    studioName: "Willow Electrolysis",
    serviceName: "90 minute session",
    durationMinutes: 90,
    startsAt: STARTS,
    timezone: TZ,
    actorName: "Chloe Vemuri LE",
    actorRole: "client",
    reason: "Schedule changed",
    isClient: false,
    ...overrides,
  });
}

describe("cancellationActorRoleLabel", () => {
  it("maps every role to a human label (no internal enum leaks)", () => {
    expect(cancellationActorRoleLabel("client")).toBe("Client");
    expect(cancellationActorRoleLabel("practitioner")).toBe("Practitioner");
    expect(cancellationActorRoleLabel("owner")).toBe("Studio owner");
    expect(cancellationActorRoleLabel("system")).toBe("System");
  });
});

describe("cancellationActorSummary: name with role, or role-only fallback", () => {
  it("renders '<name> (<Role>)' when a display name is present", () => {
    expect(cancellationActorSummary("Chloe Vemuri LE", "client")).toBe(
      "Chloe Vemuri LE (Client)",
    );
    expect(cancellationActorSummary("Sam Owner", "owner")).toBe(
      "Sam Owner (Studio owner)",
    );
  });
  it("falls back to the role label alone when the name is missing/blank", () => {
    expect(cancellationActorSummary(null, "client")).toBe("Client");
    expect(cancellationActorSummary("   ", "practitioner")).toBe("Practitioner");
    expect(cancellationActorSummary(undefined, "owner")).toBe("Studio owner");
  });
});

describe("practitioner-facing cancellation email: the reported example", () => {
  const out = studioFacing(); // client actor, named
  it("subject names the actor + service + month/day", () => {
    expect(out.subject).toBe(
      "Appointment cancelled by Chloe Vemuri LE: 90 minute session on July 21",
    );
  });
  it("body shows Client, Cancelled by (name and role), Original time, Service+duration, Reason", () => {
    expect(out.text).toContain("Client: Chloe Vemuri LE");
    expect(out.text).toContain(
      `Cancelled by: ${cancellationActorSummary("Chloe Vemuri LE", "client")}`,
    );
    expect(out.text).toContain("Original time: ");
    expect(out.text).toContain("July 21, 2026 at 1:30 PM");
    expect(out.text).toContain("Service: 90 minute session (90 min)");
    expect(out.text).toContain("Reason: Schedule changed");
    // The actor value + service also render in the HTML body.
    expect(out.html).toContain(cancellationActorSummary("Chloe Vemuri LE", "client"));
    expect(out.html).toContain("90 minute session (90 min)");
  });
});

describe("actor role is attributed correctly for every path", () => {
  const cases: Array<{
    role: CancellationActorRole;
    name: string;
    expectSummary: string;
    expectSubject: string;
  }> = [
    {
      role: "client",
      name: "Chloe Vemuri LE",
      expectSummary: "Chloe Vemuri LE (Client)",
      expectSubject: "Appointment cancelled by Chloe Vemuri LE: 90 minute session on July 21",
    },
    {
      role: "practitioner",
      name: "Dr. Alex Kim",
      expectSummary: "Dr. Alex Kim (Practitioner)",
      expectSubject: "Appointment cancelled by Dr. Alex Kim: 90 minute session on July 21",
    },
    {
      role: "owner",
      name: "Sam Owner",
      expectSummary: "Sam Owner (Studio owner)",
      expectSubject: "Appointment cancelled by Sam Owner: 90 minute session on July 21",
    },
    {
      role: "system",
      name: "Hone",
      expectSummary: "Hone (System)",
      expectSubject: "Appointment cancelled by Hone: 90 minute session on July 21",
    },
  ];
  for (const c of cases) {
    it(`${c.role}: "Cancelled by: ${c.expectSummary}"`, () => {
      const out = studioFacing({ actorName: c.name, actorRole: c.role });
      expect(out.text).toContain(`Cancelled by: ${c.expectSummary}`);
      expect(out.subject).toBe(c.expectSubject);
    });
  }
});

describe("missing-name fallback", () => {
  it("renders 'Cancelled by: <Role>' and a role-worded subject when no name is available", () => {
    const out = studioFacing({ actorName: null, actorRole: "client" });
    expect(out.text).toContain("Cancelled by: Client");
    expect(out.text).not.toMatch(/Cancelled by: Client \(/); // no dangling separator
    expect(out.subject).toBe(
      "Appointment cancelled by the client: 90 minute session on July 21",
    );
  });
  it("practitioner with no name → 'Cancelled by: Practitioner'", () => {
    const out = studioFacing({ actorName: "  ", actorRole: "practitioner" });
    expect(out.text).toContain("Cancelled by: Practitioner");
    expect(out.subject).toBe(
      "Appointment cancelled by the practitioner: 90 minute session on July 21",
    );
  });
});

describe("safety: no IDs, tokens, raw audit JSON, or notes", () => {
  it("renders only display fields", () => {
    const out = studioFacing({ actorName: "Hone", actorRole: "system" });
    for (const body of [out.subject, out.html, out.text]) {
      expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i); // no uuid
      expect(body).not.toMatch(/token|actor_id|actor_type|appointment_id/i);
      expect(body).not.toContain("{"); // no raw JSON blob
    }
  });
  it("no-name case still omits internal enum values", () => {
    const out = studioFacing({ actorName: null, actorRole: "owner" });
    // The label is "Studio owner", never the raw "owner" enum on its own line.
    expect(out.text).toContain("Cancelled by: Studio owner");
  });
});

describe("wiring guard: actor is derived server-side, never from the request", () => {
  const read = (rel: string) =>
    readFileSync(path.resolve(__dirname, "../../..", rel), "utf8");
  const PUBLIC = read("app/cancel/[token]/actions.ts");
  const PRACT = read("app/(app)/calendar/actions.ts");

  it("public token cancel: actorRole 'client', name from the server-resolved client record", () => {
    expect(PUBLIC).toMatch(/actorRole:\s*"client"/);
    expect(PUBLIC).toMatch(/actorName:\s*apptClient\?\.name/);
    // The actor never comes from the submitted form/reason fields.
    expect(PUBLIC).not.toMatch(/actorName:\s*(formData|reasonValue|noteValue|p_note)/);
  });

  it("practitioner cancel: actor is the authenticated practitioner (display name + email fallback), role from the live row", () => {
    expect(PRACT).toMatch(/actorName:\s*practitioner\.display_name\?\.trim\(\)\s*\|\|\s*practitioner\.email/);
    expect(PRACT).toMatch(/actorRole:\s*practitioner\.role === "owner" \? "owner" : "practitioner"/);
  });
});
