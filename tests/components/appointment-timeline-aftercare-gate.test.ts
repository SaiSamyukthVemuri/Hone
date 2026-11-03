import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// Codex at 5b7d431e2 (clients/[id]/page.tsx:1683): the Sessions-tab timeline showed postcare send times and attempt counts with
// clin.view_aftercare off. The loader no longer selects them without the key, and the component says so instead of showing nothing.

vi.mock("next/link", async () => {
  const react = await import("react");
  return { default: (props: { href: string; children?: ReactNode }) => react.createElement("a", { href: props.href }, props.children) };
});

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ClientAppointmentTimeline } = await import("@/components/client-appointment-timeline");

const ROW = {
  id: "a1",
  starts_at: "2026-10-01T15:00:00.000Z",
  ends_at: "2026-10-01T16:00:00.000Z",
  status: "completed" as const,
  service_id: "s1",
  service_name: "Electrolysis",
  service_modality: "electrolysis",
  cancelled_at: null,
  cancellation_reason: null,
  postcare_email_sent_at: "2026-10-01T17:00:00.000Z",
  postcare_email_send_attempts: 3,
  linked_session: null,
};
const render = (aftercareAvailable: boolean) =>
  renderToStaticMarkup(createElement(ClientAppointmentTimeline, { clientId: "c1", rows: [ROW as never], aftercareAvailable }));

describe("ClientAppointmentTimeline postcare detail", () => {
  it("clin.view_aftercare ON: the send time and attempts show, and no notice", () => {
    const html = render(true);
    expect(html).toContain("Postcare sent");
    expect(html).toContain("3 attempts");
    expect(html).not.toContain("aftercare-not-available");
  });

  it("clin.view_aftercare OFF: no send time, no attempt count, and the not-available notice is shown (even if a caller passed the data)", () => {
    const html = render(false);
    expect(html).not.toContain("Postcare sent");
    expect(html).not.toContain("attempts");
    expect(html).toContain("Aftercare details are not available to your role.");
    expect(html).toContain('data-testid="aftercare-not-available"');
  });
});

describe("getAppointmentsForClientProfile does not select the postcare columns without the key", () => {
  it("the select string omits them when includeAftercare is false", async () => {
    const selects: string[] = [];
    vi.resetModules();
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => ({
        from: () => {
          const q: Record<string, unknown> = {};
          q.select = (cols: string) => {
            selects.push(cols);
            return q;
          };
          for (const m of ["eq", "order", "is", "in"]) q[m] = () => q;
          q.limit = async () => ({ data: [], error: null });
          return q;
        },
      }),
    }));
    const { getAppointmentsForClientProfile } = await import("@/lib/supabase/queries");
    await getAppointmentsForClientProfile("studio1", "client1", { includeAftercare: false });
    await getAppointmentsForClientProfile("studio1", "client1", { includeAftercare: true });
    expect(selects[0]).not.toMatch(/postcare_email/);
    expect(selects[1]).toMatch(/postcare_email_sent_at, postcare_email_send_attempts/);
    vi.doUnmock("@/lib/supabase/server");
  });
});
