import { describe, expect, it, vi } from "vitest";
import { getCalendarRebookSource } from "@/lib/calendar/rebook-source";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient }));
const id = "12345678-1234-4234-8234-123456789012";

function scopedAppointment(studio: string, active: boolean, archived: string | null) {
  const record: Record<string, unknown> = {
    id, studio_id: studio, "client.studio_id": studio, "client.archived_at": archived,
    "service.studio_id": studio, "service.active": active,
    client_id: "client", service_id: "service", duration_minutes: 45, practitioner_id: "previous",
  };
  let visible = true;
  const query = {
    select: () => query,
    eq: (field: string, value: unknown) => { visible &&= record[field] === value; return query; },
    is: (field: string, value: unknown) => query.eq(field, value),
    maybeSingle: async () => ({ data: visible ? record : null, error: null }),
  };
  createClient.mockResolvedValue({ from: () => query });
}

describe("rebooking from a previous appointment", () => {
  it("returns the original client, service, duration and practitioner", async () => {
    scopedAppointment("studio", true, null);
    expect(await getCalendarRebookSource("studio", id)).toEqual({
      clientId: "client", serviceId: "service", durationMinutes: 45, practitionerId: "previous",
    });
  });

  it("excludes another studio's booking, an inactive service and an archived client", async () => {
    scopedAppointment("other", true, null);
    expect(await getCalendarRebookSource("studio", id)).toBeNull();
    scopedAppointment("studio", false, null);
    expect(await getCalendarRebookSource("studio", id)).toBeNull();
    scopedAppointment("studio", true, "2026-11-23");
    expect(await getCalendarRebookSource("studio", id)).toBeNull();
  });

  it("skips the lookup on normal calendar visits or malformed links", async () => {
    createClient.mockClear();
    expect(await getCalendarRebookSource("studio", undefined)).toBeNull();
    expect(await getCalendarRebookSource("studio", "invalid")).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });
});
