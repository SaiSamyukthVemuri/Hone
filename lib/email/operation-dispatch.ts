import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { MinimalEmailTransport } from "./e2e-fake-resend";
import { classifyEmailOperationObservation, isClosedEmailOperationPayload, type EmailOperationObservation, parseEmailOperationRender, type EmailOperationRender } from "./operation-state";

// SOURCE PREPARATION ONLY: no production caller or SQL adapter. The injected
// authority must persist the capability binding and possible-attempt boundary
// before returning authorized. It must never reauthorize UNKNOWN work.
type Payload = Parameters<MinimalEmailTransport["emails"]["send"]>[0];
export type EmailOperationContext = Readonly<{
  operationId: string;
  studioId: string;
  appointmentId: string;
  purpose: "reminder_24h" | "reminder_2h";
  authority: Readonly<{ appointment: string; client: string; studio: string; intake: string }>;
  providerAccount: string;
  providerKey: string;
}>;
type Context = EmailOperationContext;
export type EmailOperationBinding = Readonly<Context & { channel: "email"; requestDigest: string; capabilityDigest: string }>;
type Binding = EmailOperationBinding;
export type EmailOperationAuthorization =
  | { kind: "authorized"; firstPossibleAttemptAt: string; retryNotAfter: string | null }
  | { kind: "held" };
type Authorization = EmailOperationAuthorization;
type Handle = Readonly<object>;
type Result = { kind: "held" } | { kind: "observed"; observation: EmailOperationObservation; persistence: "recorded" | "unconfirmed" };

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Private trusted-server seam, not a Server Action/API or provider receipt
 * setter. SDK-observed acceptance is asserted by this adapter, not independently
 * verified by SQL and not delivery. A compromised trusted runtime is outside
 * that claim. No body/token/key/capability is logged or persisted here. */
export function createEmailOperationDispatchAdapter(ports: {
  authorize: (binding: Binding) => Promise<Authorization>;
  // The future scoped command verifies the ORIGINAL authorization capability,
  // operation/cohort/request binding, then separately CASes current projection.
  // It must retain late acceptance without clearing a successor's lease.
  observe: (binding: Binding, capability: string, observation: EmailOperationObservation) => Promise<void>;
  send: (payload: Payload, options: Readonly<{ idempotencyKey: string }>) => Promise<unknown>;
}) {
  type Request = { payload: Payload; context: Context; digest: string; authorizationStarted: boolean };
  type Grant = { request: Request; binding: Binding; capability: string; consumed: boolean };
  const requests = new WeakMap<Handle, Request>();
  const grants = new WeakMap<Handle, Grant>();

  return Object.freeze({
    freeze(payload: Payload, context: Context, requestBinding: unknown = null): Handle | null {
      if (!isClosedEmailOperationPayload(payload)) return null;
      // Detach every mutable request byte, including caller-owned Buffers.
      const copy: Payload = {
        from: payload.from, to: payload.to, subject: payload.subject,
        html: payload.html, text: payload.text,
        ...(payload.replyTo === undefined ? {} : { replyTo: payload.replyTo }),
        ...(payload.tags === undefined ? {} : { tags: payload.tags.map((tag) => ({ name: tag.name, value: tag.value })) }),
        ...(payload.attachments === undefined ? {} : { attachments: payload.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content) })) }),
      };
      const scope = Object.freeze({ ...context, authority: Object.freeze({ ...context.authority }) });
      const requestDigest = digest(JSON.stringify([scope, copy, requestBinding]));
      const handle = Object.freeze({});
      requests.set(handle, { payload: copy, context: scope, digest: requestDigest, authorizationStarted: false });
      return handle;
    },

    async authorize(requestHandle: Handle): Promise<Handle | null> {
      const request = requests.get(requestHandle);
      if (!request || request.authorizationStarted) return null;
      // Synchronous, including before the authorization await: no duplicate
      // authorization from reentrant calls against this in-memory request.
      request.authorizationStarted = true;
      const capability = randomBytes(32).toString("hex"); // opaque token, not an encryption key
      const binding: Binding = Object.freeze({ ...request.context, channel: "email", requestDigest: request.digest, capabilityDigest: digest(capability) });
      let result: Authorization;
      try { result = await ports.authorize(binding); } catch { return null; }
      if (result.kind !== "authorized" || !Number.isFinite(Date.parse(result.firstPossibleAttemptAt))) return null;
      // NULL horizon never grants replay; there is no replay operation here.
      const grant = Object.freeze({});
      grants.set(grant, { request, binding, capability, consumed: false });
      return grant;
    },

    async dispatchAndSettle(requestHandle: Handle, grantHandle: Handle): Promise<Result> {
      const grant = grants.get(grantHandle);
      if (!grant || grant.consumed) return { kind: "held" };
      // Consume before ANY await/SDK, even for a mismatched request. Cloning a
      // branded-looking object or passing another adapter's handle cannot win.
      grant.consumed = true;
      if (requests.get(requestHandle) !== grant.request) return { kind: "held" };
      const persist = async (observation: EmailOperationObservation): Promise<Result> => {
        try {
          await ports.observe(grant.binding, grant.capability, observation);
          return { kind: "observed", observation, persistence: "recorded" };
        } catch {
          // Keep actual SDK evidence distinct from failed persistence. Neither
          // grants replay; the original possible-effect fence must persist.
          return { kind: "observed", observation, persistence: "unconfirmed" };
        }
      };
      const completion = (async () => {
        try {
          const reply = await ports.send(grant.request.payload, { idempotencyKey: grant.binding.providerKey });
          return classifyEmailOperationObservation({ kind: "reply", reply });
        } catch {
          return classifyEmailOperationObservation({ kind: "transport" });
        }
      })().then(persist);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<Result>((resolve) => {
        timer = setTimeout(() => { void persist({ kind: "unknown", reason: "timeout" }).then(resolve); }, 15_000);
      });
      try { return await Promise.race([completion, timeout]); } finally {
        clearTimeout(timer);
        // A timed-out SDK cannot be cancelled. completion still retains late
        // evidence against the ORIGINAL capability, never a successor lease.
      }
    },
  });
}


/** Only this projection-based facade is used by the matching 0247 caller.
 * Payload construction is private and synchronous, before authority/SDK.
 * Original render/config are bound into the EXISTING full request digest;
 * there is no separately persisted clinical fingerprint or render store. */
export function createProjectedEmailOperationDispatchAdapter(ports: {
  render: (projection: EmailOperationRender) => Payload | null;
  currentRuntimeBinding: () => string;
  authorize: (binding: Binding, projection: EmailOperationRender) => Promise<Authorization>;
  observe: (binding: Binding, capability: string, observation: EmailOperationObservation, projection: EmailOperationRender) => Promise<void>;
  send: (payload: Payload, options: Readonly<{ idempotencyKey: string }>) => Promise<unknown>;
}) {
  type Entry = { adapter: ReturnType<typeof createEmailOperationDispatchAdapter>; request: Handle };
  const requests = new WeakMap<Handle, Entry>();
  const grants = new WeakMap<Handle, { entry: Entry; grant: Handle; consumed: boolean }>();
  return Object.freeze({
    freeze(value: unknown, context: Context): Handle | null {
      try {
        const projection = parseEmailOperationRender(value); if (!projection) return null;
        if ("kind" in projection ? projection.kind !== context.purpose : projection.appointment.id !== context.appointmentId || projection.studio.id !== context.studioId) return null;
        const runtime = ports.currentRuntimeBinding(); if (!runtime) return null;
        const payload = ports.render(projection); if (!payload || payload.attachments !== undefined) return null;
        if (runtime !== ports.currentRuntimeBinding()) return null;
        const adapter = createEmailOperationDispatchAdapter({
          authorize: async (binding) => runtime === ports.currentRuntimeBinding() ? ports.authorize(binding, projection) : { kind: "held" },
          observe: (binding, capability, observation) => ports.observe(binding, capability, observation, projection),
          send: (request, options) => {
            if (runtime !== ports.currentRuntimeBinding()) throw new Error("email_operation_runtime_changed");
            return ports.send(request, options);
          },
        });
        const request = adapter.freeze(payload, context, { render: projection, runtime }); if (!request) return null;
        const handle = Object.freeze({}); requests.set(handle, { adapter, request }); return handle;
      } catch { return null; }
    },
    async authorize(handle: Handle): Promise<Handle | null> {
      const entry = requests.get(handle); if (!entry) return null;
      const grant = await entry.adapter.authorize(entry.request); if (!grant) return null;
      const handleGrant = Object.freeze({}); grants.set(handleGrant, { entry, grant, consumed: false }); return handleGrant;
    },
    async dispatchAndSettle(handle: Handle, grantHandle: Handle): Promise<Result> {
      const g = grants.get(grantHandle); if (!g || g.consumed) return { kind: "held" };
      g.consumed = true; if (requests.get(handle) !== g.entry) return { kind: "held" };
      return g.entry.adapter.dispatchAndSettle(g.entry.request, g.grant);
    },
  });
}
