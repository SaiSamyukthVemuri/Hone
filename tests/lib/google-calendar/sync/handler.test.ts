import { describe, expect, it, vi } from "vitest";
import { handleCalendarSyncJob, type HandlerDeps } from "@/lib/google-calendar/sync/handler";
import type { ClaimedJob, JobResult } from "@/lib/google-calendar/sync/job-result";
import type { ConnectionAuthRow, TokenManager, TokenResult } from "@/lib/google-calendar/sync/token-manager";

type EnsureFn = (connectionId: string, studioId: string) => Promise<TokenResult>;

// Phase B2.1: the transport-neutral handler's eligibility gate + token
// acquisition + injected-operation dispatch, across the full JobResult matrix.
// No Google event is ever created here (operations are mocked).

// B2.4: eligibility is DESTINATION-AWARE. A connection needs the EXACT destination
// scope; broad calendar.events satisfies nothing.
const EVENTS_OWNED = "https://www.googleapis.com/auth/calendar.events.owned";
const EVENTS_BROAD = "https://www.googleapis.com/auth/calendar.events";

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
    grantedScopes: [EVENTS_OWNED],
    writeCalendarId: "primary",
    isStudioCalendarOwner: true,
    tokenExpiresAt: null,
    destinationMode: "existing_owned",
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

  it("missing destination scope -> terminal_insufficient_scope", async () => {
    const r = await handleCalendarSyncJob(
      job(),
      deps({ store: { loadConnection: async () => conn({ grantedScopes: ["openid"] }) } as unknown as HandlerDeps["store"] }),
    );
    expect(r.code).toBe("terminal_insufficient_scope");
  });

  it("broad calendar.events does NOT satisfy an existing_owned destination -> terminal_insufficient_scope", async () => {
    const r = await handleCalendarSyncJob(
      job(),
      deps({
        store: {
          loadConnection: async () =>
            conn({ destinationMode: "existing_owned", grantedScopes: [EVENTS_BROAD] }),
        } as unknown as HandlerDeps["store"],
      }),
    );
    expect(r.code).toBe("terminal_insufficient_scope");
    expect(r.errorCode).toBe("missing_destination_scope");
  });

  it("NULL destination -> terminal_insufficient_scope (fail closed even with an event scope)", async () => {
    const r = await handleCalendarSyncJob(
      job(),
      deps({
        store: {
          loadConnection: async () => conn({ destinationMode: null, grantedScopes: [EVENTS_OWNED] }),
        } as unknown as HandlerDeps["store"],
      }),
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

describe("execution-time revalidation: pre-token + post-token authoritative gate (§2/§4)", () => {
  type EnsureImpl = () => Promise<{ ok: true; accessToken: string; connection: ConnectionAuthRow }>;
  function setup(opts: { preConn?: ConnectionAuthRow; tokenConn?: ConnectionAuthRow; outbound?: () => Promise<boolean> }) {
    const opSpy = vi.fn(async (): Promise<JobResult> => ({ code: "ok" }));
    const captured: ConnectionAuthRow[] = [];
    const op = vi.fn(async (ctx: { connection: ConnectionAuthRow }): Promise<JobResult> => { captured.push(ctx.connection); return opSpy(); });
    const pre = opts.preConn ?? conn();
    const tok = opts.tokenConn ?? conn();
    const ensure = vi.fn<EnsureImpl>(async () => ({ ok: true, accessToken: "at", connection: tok }));
    const d = deps({
      store: { loadConnection: async () => pre } as unknown as HandlerDeps["store"],
      tokenManager: { ensureAccessToken: ensure as unknown as EnsureFn },
      isStudioOutboundEnabled: opts.outbound ?? (async () => true),
      operations: { "event.create": op },
    });
    return { d, opSpy, ensure, captured };
  }

  it("1. initial connection has no writeCalendarId -> no token work, operation not called, retry_ineligible", async () => {
    const { d, opSpy, ensure } = setup({ preConn: conn({ writeCalendarId: null }) });
    const r = await handleCalendarSyncJob(job(), d);
    expect(r).toEqual({ code: "retry_ineligible", errorCode: "missing_write_calendar" });
    expect(ensure).not.toHaveBeenCalled();
    expect(opSpy).not.toHaveBeenCalled();
  });

  it("2. token.connection has no writeCalendarId -> operation not called, retry_ineligible", async () => {
    const { d, opSpy } = setup({ tokenConn: conn({ writeCalendarId: "" }) });
    expect((await handleCalendarSyncJob(job(), d))).toEqual({ code: "retry_ineligible", errorCode: "missing_write_calendar" });
    expect(opSpy).not.toHaveBeenCalled();
  });

  it("3. scope present initially but missing from token.connection -> operation not called, terminal_insufficient_scope", async () => {
    const { d, opSpy } = setup({ tokenConn: conn({ grantedScopes: ["openid"] }) });
    expect((await handleCalendarSyncJob(job(), d)).code).toBe("terminal_insufficient_scope");
    expect(opSpy).not.toHaveBeenCalled();
  });

  it("4. token.connection reconnect_required -> operation not called, terminal_reconnect_required", async () => {
    const { d, opSpy } = setup({ tokenConn: conn({ connectionStatus: "reconnect_required" }) });
    expect((await handleCalendarSyncJob(job(), d)).code).toBe("terminal_reconnect_required");
    expect(opSpy).not.toHaveBeenCalled();
  });

  it("5. token.connection disconnected -> operation not called, retry_ineligible", async () => {
    const { d, opSpy } = setup({ tokenConn: conn({ connectionStatus: "disconnected" }) });
    expect((await handleCalendarSyncJob(job(), d))).toEqual({ code: "retry_ineligible", errorCode: "connection_not_eligible" });
    expect(opSpy).not.toHaveBeenCalled();
  });

  it("6. token.connection no longer studio owner -> operation not called, retry_ineligible", async () => {
    const { d, opSpy } = setup({ tokenConn: conn({ isStudioCalendarOwner: false }) });
    expect((await handleCalendarSyncJob(job(), d))).toEqual({ code: "retry_ineligible", errorCode: "connection_not_eligible" });
    expect(opSpy).not.toHaveBeenCalled();
  });

  it("7. outbound flag true before token, false after -> operation not called, retry_ineligible", async () => {
    const outbound = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(true).mockResolvedValue(false);
    const { d, opSpy } = setup({ outbound });
    expect((await handleCalendarSyncJob(job(), d))).toEqual({ code: "retry_ineligible", errorCode: "outbound_flag_off" });
    expect(opSpy).not.toHaveBeenCalled();
    expect(outbound).toHaveBeenCalledTimes(2); // read pre-token AND immediately before dispatch
  });

  it("9. valid token.connection -> the operation receives token.connection, NOT the stale pre-token connection", async () => {
    const { d, captured } = setup({ preConn: conn({ writeCalendarId: "OLD-CAL" }), tokenConn: conn({ writeCalendarId: "NEW-CAL" }) });
    const r = await handleCalendarSyncJob(job(), d);
    expect(r).toEqual({ code: "ok" });
    expect(captured).toHaveLength(1);
    expect(captured[0].writeCalendarId).toBe("NEW-CAL"); // the authoritative token.connection
    expect(captured[0].writeCalendarId).not.toBe("OLD-CAL");
  });

  it("10. broad calendar.events alone on token.connection remains rejected -> terminal_insufficient_scope", async () => {
    const { d, opSpy } = setup({ tokenConn: conn({ destinationMode: "existing_owned", grantedScopes: [EVENTS_BROAD] }) });
    expect((await handleCalendarSyncJob(job(), d)).code).toBe("terminal_insufficient_scope");
    expect(opSpy).not.toHaveBeenCalled();
  });
});
