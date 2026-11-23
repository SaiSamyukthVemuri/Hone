// Compares the privileges the database really grants with the ones recorded in permission-coverage.registry.ts.
// Commands that only exist where the permission engine is installed (absent on a database built from the repository
// migrations alone, such as local and CI stacks) may be ABSENT, and then must be recorded as nothing else: absence is
// asserted, never skipped silently, and every other command is still compared. When one is present its grants are
// compared like any other.

export const ENGINE_ONLY_RPCS: readonly string[] = ["has_studio_permission"];

export function rpcPrivilegeDrift(
  names: readonly string[],
  live: Readonly<Record<string, string>>,
  recorded: Readonly<Record<string, string>>,
  engineOnly: readonly string[] = ENGINE_ONLY_RPCS,
): string[] {
  return names
    .filter((n) => !(engineOnly.includes(n) && live[n] === "ABSENT") && live[n] !== recorded[n])
    .map((n) => `${n}: recorded ${recorded[n]}, database ${live[n]}`);
}
