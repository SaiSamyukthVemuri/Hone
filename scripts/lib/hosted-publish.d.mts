// Types for the tests only; the runner is plain .mjs.
export class Refusal extends Error {}
export const ACTION: string;
export const RPC: string;
export const KEY_VAR: string;
export const URL_VAR: string;
export function sha256(s: string): string;
export function shortFingerprint(s: string): string;
export function redact(text: unknown, key?: string): string;
export function startupRefusals(a: { env: Record<string, string | undefined>; execArgv: string[]; stdinTTY: boolean; stdoutTTY: boolean; vpsMarker: string | null }): string[];
export function parseHostedUrl(url: unknown): string;
export function keyRefClaim(key: string): string | null;
export function plannedSet(plan: { publish: Array<Record<string, unknown>> }): string[];
export function projectPlanRow(row: Record<string, unknown>): unknown;
export function projectContract(c: { channels_max?: unknown; requires_installed_option?: unknown; fields: Array<Record<string, unknown>> }): unknown;
export function ledgerNames(tokenSha256: string): { intent: string; receipt: string };
export function checkToken(a: Record<string, unknown>): { token: Record<string, unknown>; tokenSha256: string };
export function runHosted(d: Record<string, unknown>): Promise<Record<string, unknown>>;
export function makeHostedClient(a: { url: string; key: string; fetchImpl?: unknown; checkUrl?: (url: string) => unknown }): {
  fingerprint(): Promise<unknown>; readContract(row: unknown): Promise<unknown>; rpc(name: string, args: unknown): Promise<unknown>;
};
export function makeFsLedger(dir: string): { exists(name: string): boolean; createExclusive(name: string, body: string): void; writeAtomic(name: string, body: string): void };
