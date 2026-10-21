import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { MinimalEmailTransport } from "./e2e-fake-resend";
import { classifyEmailOperationObservation, isClosedEmailOperationPayload, type EmailOperationObservation } from "./operation-state";

// SOURCE PREPARATION ONLY: no production caller or SQL adapter. The injected
// authority must persist the capability binding and possible-attempt boundary
// before returning authorized. It must never reauthorize UNKNOWN work.
type Payload = Parameters<MinimalEmailTransport["emails"]["send"]>[0];
type Context = Readonly<{
  operationId: string;
  studioId: string;
  appointmentId: string;
  purpose: "reminder_24h" | "reminder_2h";
  authority: Readonly<{ appointment: string; client: string; studio: string; intake: string }>;
  providerAccount: string;
  providerKey: string;
}>;
type Binding = Readonly<Context & { channel: "email"; requestDigest: string; capabilityDigest: string }>;
type Authorization =
  | { kind: "authorized"; firstPossibleAttemptAt: string; retryNotAfter: string | null }
  | { kind: "held" };
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
    freeze(payload: Payload, context: Context): Handle | null {
      if (!isClosedEmailOperationPayload(payload)) return null;
      // Detach every mutable request byte, including caller-owned Buffers.
      const copy: Payload = {
        from: payload.from, to: payload.to, subject: payload.subject,
        html: payload.html, text: payload.text,
        ...(payload.replyTo === undefined ? {} : { replyTo: payload.replyTo }),
        ...(payload.attachments === undefined ? {} : { attachments: payload.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content) })) }),
      };
      const scope = Object.freeze({ ...context, authority: Object.freeze({ ...context.authority }) });
      const requestDigest = digest(JSON.stringify([scope, copy]));
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
