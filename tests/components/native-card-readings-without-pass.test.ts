// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// A native (MultiPlex) area's recorded readings belong to the AREA, not to a pass: they stay on the card when the last pass is removed. And the
// existing xCell workflow's area (its model on the block, readings in the legacy columns) keeps its pulse count.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/clients/c1/sessions/s1",
}));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions", async (orig) => Object.fromEntries(Object.keys(await orig<Record<string, unknown>>()).map((k) => [k, vi.fn(async () => ({ ok: true }))])));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions", async (orig) => Object.fromEntries(Object.keys(await orig<Record<string, unknown>>()).map((k) => [k, vi.fn(async () => ({ ok: true }))])));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/actions", async (orig) => Object.fromEntries(Object.keys(await orig<Record<string, unknown>>()).map((k) => [k, vi.fn(async () => ({ ok: true }))])));

import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { SessionBlocksView } from "@/app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view";
import type { RecordedReading } from "@/lib/machines/machine-queries";

const reading = (stageKey: string | null, fieldKey: string, value: number, decimals: number): RecordedReading =>
  ({
    blockId: "b1", captureId: "cap1", revision: 1, deviceId: "u1", profileId: "dectro-apilus:xcell-pur", profileVersion: 1, modeKey: "multiplex",
    groupId: "g1", channels: [], stageKey, fieldKey, value: { kind: "number", value }, nativeUnit: "count", decimals, observationSource: "practitioner-entered",
    recordedAt: "2026-11-25T10:00:00Z", sessionId: "s1",
  }) as unknown as RecordedReading;

const block = (over: Record<string, unknown>) => ({
  id: "b1", session_id: "s1", sort_order: 1, primary_area: "Chin", side: "left", deleted_at: null, areas: [], electrolysis_entries: [], structured_areas: [],
  machine_profile_id: null, machine_mode_key: null, studio_machine_id: null, ...over,
});
const render = (b: unknown, extra: Record<string, unknown> = {}) =>
  renderToString(createElement(SessionBlocksView as never, { sessionId: "s1", clientId: "c1", blocks: [b], orphanEntries: [], ...extra } as never))
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("area card", () => {
  it("a native area with NO pass left still shows its recorded readings", () => {
    const text = render(block({ machine_profile_id: "dectro-apilus:xcell-pur", machine_mode_key: "multiplex", studio_machine_id: "u1" }), {
      nativeReadings: { b1: { readings: [reading("snap", "snap_count", 3, 0)], unavailable: false } },
      nativeUnitNames: { u1: "xCell" },
    });
    expect(text).toContain("No entries yet");
    expect(text).toMatch(/Pulse count\s*3/);
  });
  it("the existing xCell workflow's area keeps its legacy pulse count on the card", () => {
    const text = render(
      block({
        machine_profile_id: "dectro-apilus:xcell",
        electrolysis_entries: [{ id: "e1", session_id: "s1", block_id: "b1", area: "Chin", areas: ["Chin"], mode: "thermo", pulse_count: 4, pulse_delay_seconds: null, observation_chips: [], created_at: "2026-11-25T10:00:00Z" }],
      }),
    );
    expect(text).toContain("4 pulses");
  });
});
