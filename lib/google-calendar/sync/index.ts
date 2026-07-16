import "server-only";

// Google Calendar — Phase B2.1 worker core (transport-neutral). Barrel export.
// Nothing here enqueues appointments, calls Google against real data, or runs a
// production cron; it is the reusable core the B2.3-c worker consumes.
//
// B2.3-c1 adds the dormant event-operation layer (serializer, deterministic
// identity, stale fence, create/update/delete operations, and the transactional
// link-transition store). The operations map is imported ONLY by server-only
// worker modules; no app route wires it and the worker/flags stay OFF.

export * from "./job-result";
export * from "./errors";
export * from "./backoff";
export * from "./google-rest-client";
export * from "./access-token-cache";
export * from "./token-manager";
export * from "./pg-refresh-coordinator";
export * from "./connection-store";
export * from "./handler";
export * from "./adapters";
export * from "./event-id";
export * from "./serializer";
export * from "./stale-fence";
export * from "./link-transition-store";
export * from "./operations";
