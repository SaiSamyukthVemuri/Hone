import { catalogByKey } from "./catalog";

// Enforcement point for the Roles permission engine (0287). It asks the database, never the browser or the
// catalog file, because has_studio_permission reads the CURRENT rows on every request: a saved change, a removed
// member, a reassigned appointment or a deactivated practitioner takes effect on the next request.
//
// It must be handed the SIGNED-IN user's client. The database function resolves the actor from auth.uid(); a
// service-role client has no such user, so it would answer false for every key.
//
// Behaviour is unchanged while a studio is on the existing-snapshot basis, because that basis encodes what the
// code did before. Two cases need care, and the mode records which:
//   enforce  the snapshot is what the code/database already enforces (source/verified), or the capability is new
//            and off (not_built). A denial is real. Fails CLOSED when the answer cannot be read.
//   observe  the snapshot is an approved policy the database does not enforce yet (appt.complete: today any
//            practitioner can complete any started appointment; assigned-only waits for #1315/0277). Denying
//            would narrow behaviour, so the answer is logged and never blocks. Fails OPEN, by design, and only here.
//
// Release order (Privacy X1): the engine is migration 0287, which is applied BEFORE this app. If the database says the engine does not
// exist at all (has_studio_permission is missing), enforcement is not active yet: the helper reports `engineAbsent`, allows, and the
// action keeps the legacy checks it always had (studio, role, owner). It alerts the operator once per process, never refuses everyone.
// Only "the function does not exist" counts as absent; an engine that is present but errors, throws or answers oddly still fails closed.

export type PermissionMode = "enforce" | "observe";

export type PermissionContext = {
  client?: string | null;
  appointment?: string | null;
  practitioner?: string | null;
};

type RpcResult = PromiseLike<{ data: unknown; error: unknown }>;
export type PermissionDb = {
  rpc: (fn: "has_studio_permission", args: Record<string, unknown>) => RpcResult;
};

export type PermissionDecision = {
  // What the caller must act on. Always true in observe mode.
  allowed: boolean;
  mode: PermissionMode;
  // What the engine said (null when it could not be read).
  engine: boolean | null;
  // True when the engine is not installed in this database. Then `allowed` is true and the caller's legacy checks stand.
  engineAbsent?: boolean;
};

// Postgres 42883 (undefined_function) or PostgREST PGRST202 (function not in the schema cache): the function itself is missing.
export function isEngineAbsent(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  const text = typeof message === "string" ? message : "";
  // PGRST202 is raised for the function the call named. 42883 must name has_studio_permission itself: a present engine whose inner helper is
  // missing (a partial apply) is NOT "absent", and must keep failing closed.
  if (code === "PGRST202") return true;
  if (code === "42883") return /has_studio_permission/i.test(text);
  return /could not find the function public\.has_studio_permission/i.test(text);
}

let engineAbsentAlerted = false;
// Test hook: the alert fires once per process.
export function resetEngineAbsentAlert(): void {
  engineAbsentAlerted = false;
}
function alertEngineAbsentOnce(): void {
  if (engineAbsentAlerted) return;
  engineAbsentAlerted = true;
  console.error(
    JSON.stringify({
      event: "permission_engine_absent",
      ops_alert: true,
      severity: "high",
      message: "has_studio_permission is missing: permission enforcement is inactive and legacy checks apply. Apply migration 0287 before the app that enforces it.",
      timestamp: new Date().toISOString(),
    }),
  );
}

export function permissionMode(key: string): PermissionMode {
  const def = catalogByKey.get(key);
  // An unknown key is a programming error; enforce so it can never silently allow.
  if (!def) return "enforce";
  return def.snapshotBasis === "approved_policy" ? "observe" : "enforce";
}

export async function requirePermission(
  db: PermissionDb,
  studioId: string,
  key: string,
  ctx: PermissionContext = {},
): Promise<PermissionDecision> {
  const mode = permissionMode(key);
  let engine: boolean | null = null;
  let absent = false;
  try {
    const { data, error } = await db.rpc("has_studio_permission", {
      p_studio: studioId,
      p_key: key,
      p_client: ctx.client ?? null,
      p_appointment: ctx.appointment ?? null,
      p_practitioner: ctx.practitioner ?? null,
    });
    if (!error && typeof data === "boolean") engine = data;
    else if (error && isEngineAbsent(error)) absent = true;
  } catch (e) {
    engine = null;
    absent = isEngineAbsent(e);
  }

  if (absent) {
    alertEngineAbsentOnce();
    return { allowed: true, mode, engine: null, engineAbsent: true };
  }

  if (mode === "observe") {
    // Ids only; no client data. A mismatch is the evidence R4 needs before it turns this key to enforce.
    if (engine !== true) {
      console.warn(
        JSON.stringify({
          event: "permission_observe_would_deny",
          key,
          engine,
          appointmentId: ctx.appointment ?? null,
          timestamp: new Date().toISOString(),
        }),
      );
    }
    return { allowed: true, mode, engine };
  }
  return { allowed: engine === true, mode, engine };
}
