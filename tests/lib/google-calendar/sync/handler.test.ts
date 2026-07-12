import { describe, expect, it, vi } from "vitest";
import { handleCalendarSyncJob, type HandlerDeps } from "@/lib/google-calendar/sync/handler";
import type { ClaimedJob, JobResult } from "@/lib/google-calendar/sync/job-result";
import type { ConnectionAuthRow, TokenManager, TokenResult } from "@/lib/google-calendar/sync/token-manager";

type EnsureFn = (connectionId: string, studioId: string) => Promise<TokenResult>;

// Phase B2.1 — the transport-neutral handler's eligibility gate + token
// acquisition + injected-operation dispatch, across the full JobResult matrix.
// No Google event is ever created here (operations are mocked).

const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: "job-1",
    studioId: "studio-1",
    connectionId: "conn-1",
    opType: "event.create",
    honeEntityType: "appointment",
    honeEntityId: "appt-1",
    payload: {},
    idempotencyKey: "appointment:appt-1:event.create:1",
    attempts: 1,
    maxAttempts: 8,
    claimToken: "tok",
    leaseExpiresAt: new Date().toISOString(),
    priority: 100,
    ...overrides,
  };
}

function conn(overrides: Partial<ConnectionAuthRow> = {}): ConnectionAuthRow {
  return {
    id: "conn-1",
    studioId: "studio-1",
    practitionerId: "prac-1",
    connectionStatus: "connected",
    grantedScopes: [EVENTS_SCOPE],
    writeCalendarId: "primary",
    isStudioCalendarOwner: true,
    tokenExpiresAt: null,
    ...overrides,
  };
}

function deps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  const tokenManager: TokenManager = {
    ensureAccessToken: vi.fn<EnsureFn>(async () => ({ ok: true, accessToken: "at", connection: conn() })),
  };
  return {
    store: { loadConnection: vi.fn(async () => conn()) } as unknown as HandlerDeps["store"],
    tokenManager,
    isStudioOutboundEnabled: vi.fn(async () => true),
    operations: { "event.create": async (): Promise<JobResult> => ({ code: "ok" }) },
    ...overrides,
  };
}

describe("eligibility gate", () => {
  it("missing connection -> retry_ineligible (hold, not dead)", async () => {
    const r = await handleCalendarSyncJob(job(), deps({ store: { loadConnection: async () => null } as unknown as HandlerDeps["store"] }));
    expect(r).toEqual({ code: "retry_ineligible", errorCode: "connection_missing" });
  });

  it("reconnect_required / revoked -> terminal_reconnect_required", async () => {
    for (const status of ["reconnect_required", "revoked"] as const) {
      const r = await handleCalendarSyncJob(
        job(),
        deps({ store: { loadConnection: async () => conn({ connectionStatus: status }) } as unknown as HandlerDeps["store"] }),
      );
      expect(r.code).toBe("terminal_reconnect_required");
    }
  });

  it("missing calendar.events scope -> terminal_insufficient_scope", async () => {
    const r = await handleCalendarSyncJob(
      job(),
      deps({ store: { loadConnection: async () => conn({ grantedScopes: ["openid"] }) } as unknown as HandlerDeps["store"] }),
    );
    expect(r.code).toBe("terminal_insufficient_scope");
  });

  it("not the studio calendar owner -> retry_ineligible", async () => {
    const r = await handleCalendarSyncJob(
      job(),
      deps({ store: { loadConnection: async () => conn({ isStudioCalendarOwner: false }) } as unknown as HandlerDeps["store"] }),
    );
    expect(r).toEqual({ code: "retry_ineligible", errorCode: "connection_not_eligible" });
  });

  it("outbound flag OFF -> retry_ineligible (no token work, no Google call)", async () => {
    const ensure = vi.fn<EnsureFn>(async () => ({ ok: true, accessToken: "at", connection: conn() }));
    const r = await handleCalendarSyncJob(
      job(),
      deps({ isStudioOutboundEnabled: async () => false, tokenManager: { ensureAccessToken: ensure } }),
    );
    expect(r).toEqual({ code: "retry_ineligible", errorCode: "outbound_flag_off" });
    expect(ensure).not.toHaveBeenCalled();
  });
});

describe("token acquisition mapping", () => {
  it("token reconnect_required -> terminal_reconnect_required", async () => {
    const r = await handleCalendarSyncJob(
      job(),
      deps({ tokenManager: { ensureAccessToken: (async () => ({ ok: false, kind: "reconnect_required", code: "invalid_grant" })) as EnsureFn } }),
    );
    expect(r.code).toBe("terminal_reconnect_required");
  });
  it("token insufficient_scope -> terminal_insufficient_scope", async () => {
    const r = await handleCalendarSyncJob(
      job(),
      deps({ tokenManager: { ensureAccessToken: (async () => ({ ok: false, kind: "insufficient_scope", code: "x" })) as EnsureFn } }),
    );
    expect(r.code).toBe("terminal_insufficient_scope");
  });
  it("token transient -> retry_transient with the retry-after", async () => {
    const r = await handleCalendarSyncJob(
      job(),
      deps({ tokenManager: { ensureAccessToken: (async () => ({ ok: false, kind: "transient", code: "google_http_503", retryAfterSeconds: 30 })) as EnsureFn } }),
    );
    expect(r).toEqual({ code: "retry_transient", errorCode: "google_http_503", retryAfterSeconds: 30 });
  });
});

describe("operation dispatch", () => {
  it("passes through whatever the injected operation returns", async () => {
    for (const code of ["ok", "ok_noop_superseded", "terminal_conflict", "retry_rate_limited"] as const) {
      const r = await handleCalendarSyncJob(job(), deps({ operations: { "event.create": async () => ({ code }) } }));
      expect(r.code).toBe(code);
    }
  });
  it("no operation wired (B2.1) -> retry_ineligible operation_not_implemented (held)", async () => {
    const r = await handleCalendarSyncJob(job(), deps({ operations: {} }));
    expect(r).toEqual({ code: "retry_ineligible", errorCode: "operation_not_implemented" });
  });
});
