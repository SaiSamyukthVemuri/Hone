import { renderToReadableStream } from "react-dom/server";
import { expect, it, vi } from "vitest";
import AdminIndexPage from "@/app/admin/page";
import { loadStudioListSignIns } from "@/lib/admin/studio-list-sign-in";

vi.mock("@/lib/auth/require-platform-admin", () => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/admin/studio-list-sign-in", () => ({ loadStudioListSignIns: vi.fn() }));
vi.mock("@/lib/payments/admin-payment-status", () => ({ loadPlatformPaymentSummary: async () => ({ loadError: true }) }));
vi.mock("@/lib/cron/reminder-heartbeat", () => ({
  readReminderHeartbeat: async () => null,
  computeReminderSchedulerStatus: () => ({ status: "unknown" }),
}));
vi.mock("@/app/admin/actions", () => ({ markDemoContactedAction: vi.fn() }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const rows = table === "studios" ? [{ id: "studio-1", name: "Example studio", created_at: "2026-01-01T00:00:00Z" }] : [];
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        then(resolve: (value: unknown) => void) { resolve({ data: rows, error: null, count: rows.length }); },
      };
      return query;
    },
  }),
}));

it("streams the studio list and the rest of the admin page before the last sign-in resolves", async () => {
  const at = "2026-11-26T15:00:00Z";
  let finish!: () => void;
  vi.mocked(loadStudioListSignIns).mockImplementationOnce(() => new Promise((resolve) => {
    finish = () => resolve(new Map([["studio-1", { state: "signed_in", at }]]));
  }));
  const stream = await renderToReadableStream(await AdminIndexPage());
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let shell = "";
  while (!shell.includes("Operator references")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    shell += chunk.value;
  }
  finish();
  expect(shell).toContain("Example studio");
  expect(shell).toMatch(/>Created<\/th>\s*<th[^>]*><span[^>]*>Last sign-in<\/span>/);
  expect(shell).toContain("Loading…");
  expect(shell).not.toContain(at);
  let tail = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) tail += chunk.value;
  expect(tail).toContain(at);
  expect(vi.mocked(loadStudioListSignIns)).toHaveBeenCalledTimes(1);
});
