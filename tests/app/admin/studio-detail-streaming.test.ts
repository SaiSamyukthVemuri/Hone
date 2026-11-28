import { expect, it, vi } from "vitest";
import { renderToReadableStream } from "react-dom/server";
import { createElement } from "react";
import AdminStudioPage from "@/app/admin/studios/[id]/page";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { loadStaffSignIns } from "@/lib/admin/staff-sign-in";
import { loadStudioActivity } from "@/lib/admin/studio-activity";
import { loadStudioPaymentStatus, type StudioModeRow } from "@/lib/payments/admin-payment-status";

vi.mock("@/lib/auth/require-platform-admin", () => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/admin/staff-sign-in", () => ({ loadStaffSignIns: vi.fn() }));
vi.mock("@/lib/admin/studio-activity", async (original) => ({
  ...await original<typeof import("@/lib/admin/studio-activity")>(), loadStudioActivity: vi.fn(),
}));
vi.mock("@/lib/payments/admin-payment-status", () => ({ loadStudioPaymentStatus: vi.fn() }));

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("streams studio details, activity and staff sign-ins independently of a slow payment lookup", async () => {
  const studio = { id: "studio-a", name: "Studio A", owner_email: "owner@example.test" };
  vi.mocked(createAdminClient).mockReturnValue({
    from(table: string) {
      const result = { data: table === "studios" ? studio : table === "pending_invitations" ? [] : null, error: null };
      return Object.assign(Promise.resolve(result), {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return this; },
      });
    },
  } as unknown as ReturnType<typeof createAdminClient>);
  const signIns = pending<Awaited<ReturnType<typeof loadStaffSignIns>>>();
  const payments = pending<Awaited<ReturnType<typeof loadStudioPaymentStatus>>>();
  vi.mocked(loadStaffSignIns).mockReturnValue(signIns.promise);
  vi.mocked(loadStudioPaymentStatus).mockReturnValue(payments.promise);
  vi.mocked(loadStudioActivity).mockResolvedValue({ state: "inactive", at: null });

  const stream = await renderToReadableStream(createElement(AdminStudioPage, { params: Promise.resolve({ id: studio.id }) }));
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let html = "";
  async function readThrough(marker: string) {
    while (!html.includes(marker)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Missing rendered text: ${marker}`);
      html += chunk.value;
    }
  }

  await readThrough("No recent activity");
  expect(html).toContain("Studio A");
  expect(html).toContain("Loading staff sign-ins");
  expect(html).toContain("Loading payment details");
  expect(html).not.toContain("Never signed in");

  signIns.resolve({
    staff: [{ key: "member-1", displayName: "Staff A", role: "owner", active: true, signIn: { state: "unknown" } }],
    unavailable: false, truncated: false, pendingInvites: null,
  });
  await readThrough("Staff A");
  expect(html).toContain("Unknown");
  expect(html).not.toContain("Never signed in");

  const emptyMode: StudioModeRow = {
    exists: false, accountStatus: null, capability: "not_connected", chargesEnabled: false, payoutsEnabled: false,
    accountIdRedacted: null, activeCards: 0, attempts: { succeeded: 0, active: 0, other: 0 },
  };
  payments.resolve({ runtimeMode: "test", live: emptyMode, test: emptyMode, loadError: true });
  await readThrough("Payment status could not be loaded");
  for (const read of [loadStudioActivity, loadStaffSignIns, loadStudioPaymentStatus]) {
    expect(read).toHaveBeenCalledExactlyOnceWith(expect.anything(), studio.id);
  }
});
