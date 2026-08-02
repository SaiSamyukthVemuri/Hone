// Test-facing wrapper over the canonical migration-state utility.
//
// Per-migration test files must NOT hard-code the repository max, nor carry a
// hand-maintained "nothing above me exists yet" filename regex that has to be
// bumped by hand whenever a migration lands. Those pins previously lived in 18 files
// across tests/migrations, tests/docs and tests/scripts, so adding a migration
// meant editing all of them — and a local run scoped to one directory silently
// missed the rest, which is how 0163, 0164 and 0165 each went red after push.
// Import from here instead.

// @ts-expect-error - .mjs utility ships without type declarations
import { getMigrationState, scanMigrations } from "../../../scripts/migration-state.mjs";

export type MigrationState = {
  repo_migration_max: string;
  repo_migration_max_number: number;
  next_free_migration: string;
  next_free_migration_number: number;
  total_migrations_in_repo: number;
  permanently_skipped: string[];
  hosted_migration_max: string;
  hosted_migration_max_number: number;
  hosted_applied_at: string;
  repo_equals_hosted: boolean;
  pending_migrations: string[];
  versions: string[];
  files: string[];
};

export const migrationState = (): MigrationState => getMigrationState() as MigrationState;
export const migrationFiles = (): string[] => migrationState().files;
export const migrationVersions = (): string[] => migrationState().versions;

/** True when `version` (e.g. "0165") is the current repository maximum. */
export function isRepoMax(version: string): boolean {
  return migrationState().repo_migration_max === version;
}

/**
 * Every version strictly greater than `version`. Replaces the old
 * hand-maintained filename regexes that enumerated "the next few numbers" and
 * had to be widened by hand in a dozen files each time a migration landed.
 */
export function versionsAbove(version: string): string[] {
  const n = Number.parseInt(version, 10);
  return migrationVersions().filter((v) => Number.parseInt(v, 10) > n);
}

/** How many migration files carry this exact version (must always be 1). */
export function countVersion(version: string): number {
  return migrationVersions().filter((v) => v === version).length;
}

/** The single migration file for a version, e.g. "0165_....sql". */
export function fileForVersion(version: string): string {
  const f = migrationFiles().find((x) => x.startsWith(`${version}_`));
  if (!f) throw new Error(`no migration file for version ${version}`);
  return f;
}

export { scanMigrations };
