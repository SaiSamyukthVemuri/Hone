import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #286. Clinical lineage enforcement: a charting write must prove the
// session belongs to the CLIENT in the route context, not just the studio.
// Migration 0094 already guarantees same-studio block∈session / entry∈block∈
// session; this closes the same-studio WRONG-CLIENT action gap.

// ---------------------------------------------------------------------------
// Behavioral: assertSessionForClient rejects wrong-client / missing sessions.
// ---------------------------------------------------------------------------
// A chainable Supabase query mock that records the filters and resolves
// maybeSingle() with a caller-supplied { data, error }.
type MaybeSingleResult = { data: unknown; error: unknown };
function makeSupabaseMock(result: MaybeSingleResult) {
  const filters: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is"] as const) {
    builder[m] = vi.fn((...args: unknown[]) => {
      if (m === "eq") filters[String(args[0])] = args[1];
      if (m === "is") filters[`is:${String(args[0])}`] = args[1];
      return builder;
    });
  }
  builder.maybeSingle = vi.fn(async () => result);
  const from = vi.fn(() => builder);
  return { client: { from }, from, filters };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
import { createClient } from "@/lib/supabase/server";
import {
  assertSessionForClient,
  SessionLineageError,
} from "@/lib/sessions/session-lineage";

const STUDIO = "11111111-1111-1111-1111-111111111111";
const CLIENT_A = "22222222-2222-2222-2222-222222222222";
const CLIENT_B = "33333333-3333-3333-3333-333333333333";
const SESSION = "44444444-4444-4444-4444-444444444444";

afterEach(() => vi.clearAllMocks());

describe("assertSessionForClient", () => {
  it("resolves when the session belongs to the studio AND client", async () => {
    const mock = makeSupabaseMock({ data: { id: SESSION }, error: null });
    vi.mocked(createClient).mockResolvedValue(mock.client as never);
    await expect(
      assertSessionForClient(STUDIO, CLIENT_A, SESSION),
    ).resolves.toBeUndefined();
    // Proves it queries scoped by id + studio_id + client_id + not-deleted.
    expect(mock.from).toHaveBeenCalledWith("sessions");
    expect(mock.filters.id).toBe(SESSION);
    expect(mock.filters.studio_id).toBe(STUDIO);
    expect(mock.filters.client_id).toBe(CLIENT_A);
    expect(mock.filters["is:deleted_at"]).toBeNull();
  });

  it("rejects a same-studio WRONG-CLIENT session (no row) with a generic error", async () => {
    // Client B's session does not match client_id = Client A → no row.
    const mock = makeSupabaseMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue(mock.client as never);
    await expect(
      assertSessionForClient(STUDIO, CLIENT_A, SESSION),
    ).rejects.toBeInstanceOf(SessionLineageError);
    await expect(
      assertSessionForClient(STUDIO, CLIENT_B, SESSION),
    ).rejects.toThrow("Treatment session not found.");
  });

  it("rejects on a DB error generically (never leaks the provider message)", async () => {
    const mock = makeSupabaseMock({
      data: null,
      error: { message: "secret db internals", code: "XX" },
    });
    vi.mocked(createClient).mockResolvedValue(mock.client as never);
    await expect(
      assertSessionForClient(STUDIO, CLIENT_A, SESSION),
    ).rejects.toThrow("Treatment session not found.");
    await expect(
      assertSessionForClient(STUDIO, CLIENT_A, SESSION),
    ).rejects.not.toThrow(/secret db internals/);
  });

  it("rejects missing args without touching the DB", async () => {
    const mock = makeSupabaseMock({ data: { id: SESSION }, error: null });
    vi.mocked(createClient).mockResolvedValue(mock.client as never);
    await expect(assertSessionForClient("", CLIENT_A, SESSION)).rejects.toThrow(
      "Treatment session not found.",
    );
    await expect(assertSessionForClient(STUDIO, "", SESSION)).rejects.toThrow(
      "Treatment session not found.",
    );
    await expect(assertSessionForClient(STUDIO, CLIENT_A, "")).rejects.toThrow(
      "Treatment session not found.",
    );
    expect(mock.from).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Source-grep: every block-actions charting write enforces session∈client.
// ---------------------------------------------------------------------------
const BLOCK_ACTIONS = readFileSync(
  join(
    process.cwd(),
    "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
  ),
  "utf8",
);
const SESSION_ACTIONS = readFileSync(
  join(process.cwd(), "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts"),
  "utf8",
);

describe("block-actions.ts enforces full client lineage (PR #286)", () => {
  it("imports the shared assertSessionForClient helper", () => {
    expect(BLOCK_ACTIONS).toMatch(
      /import \{ assertSessionForClient \} from "@\/lib\/sessions\/session-lineage"/,
    );
  });

  it("no longer defines or calls the studio-only assertSessionInStudio", () => {
    // Only the explanatory comment may mention the removed name; there must be
    // no function definition and no call.
    expect(BLOCK_ACTIONS).not.toMatch(/async function assertSessionInStudio/);
    expect(BLOCK_ACTIONS).not.toMatch(/await assertSessionInStudio\(/);
  });

  it("validates session∈client at every charting action (7 call sites, all with input.clientId)", () => {
    // 6 original + removeSessionAreaAction (Willow P1-B), every charting write
    // re-checks the session belongs to the route client.
    const calls = BLOCK_ACTIONS.match(
      /await assertSessionForClient\(studio\.id, input\.clientId, input\.sessionId\)/g,
    );
    expect(calls?.length).toBe(7);
  });

  it("every block-actions server action gates on assertSessionForClient", () => {
    // Each exported charting action body contains a client-lineage assertion.
    const actionNames = [
      "createSessionBlockAction",
      "updateSessionBlockAction",
      "copyPreviousSessionAreasAction",
      "softDeleteSessionBlockAction",
      "createTreatmentAreaWithEntryAction",
      "updateTreatmentAreaWithEntryAction",
    ];
    for (const name of actionNames) {
      const start = BLOCK_ACTIONS.indexOf(`export async function ${name}(`);
      expect(start, `${name} missing`).toBeGreaterThan(-1);
      // The next ~1200 chars of the action body contain the assertion.
      const body = BLOCK_ACTIONS.slice(start, start + 1400);
      expect(body, `${name} must assert session∈client`).toMatch(
        /assertSessionForClient\(studio\.id, input\.clientId/,
      );
    }
  });

  it("block + entry writes stay scoped by the (client-validated) session_id", () => {
    // Block writes carry session_id; entry writes carry session_id + block_id
    // so the 0094 chain (block∈session, entry∈block∈session) holds.
    expect(BLOCK_ACTIONS).toMatch(/session_id: input\.sessionId/);
    expect(BLOCK_ACTIONS).toMatch(/\.eq\("session_id", input\.sessionId\)/);
  });
});

describe("session-level actions.ts remains client-aware (regression)", () => {
  it("entry add/delete still validate session∈client via assertSessionVisible", () => {
    expect(SESSION_ACTIONS).toMatch(/\.eq\("client_id", clientId\)/);
    const calls = SESSION_ACTIONS.match(/assertSessionVisible\(/g);
    expect((calls?.length ?? 0)).toBeGreaterThanOrEqual(4);
  });
});
