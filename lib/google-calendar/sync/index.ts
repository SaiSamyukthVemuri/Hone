import "server-only";

// Google Calendar — Phase B2.1 worker core (transport-neutral). Barrel export.
// Nothing here enqueues appointments, calls Google against real data, or runs a
// production cron; it is the reusable core B2.3/B2.4 consume.

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
