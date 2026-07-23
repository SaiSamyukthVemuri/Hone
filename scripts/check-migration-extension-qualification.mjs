#!/usr/bin/env node
// Contract guard: every pgcrypto / uuid-ossp function call in supabase/migrations
// MUST be schema-qualified as extensions.<fn>.
//
// Why: on a fresh MANAGED Supabase project, pgcrypto (and uuid-ossp) live in the
// `extensions` schema, which is NOT on the migration session's search_path. A bare
// call such as `gen_random_bytes(...)` therefore fails at parse/plan time with
// SQLSTATE 42883 "function ... does not exist" — even on an empty database and even
// though older prod projects and the local dev stack (pgcrypto reachable on the
// path) resolve it fine. This guard is the deterministic regression fence for the
// 0025_email_system.sql fresh-apply defect: it makes the whole 0001->NNNN chain
// reproducible on a fresh managed project.
//
// gen_random_uuid() is a pg_catalog BUILT-IN (not pgcrypto) and is intentionally
// NOT flagged. Schema-qualified calls (extensions.<fn>( or pgcrypto.<fn>() and any
// call preceded by a table/column qualifier (foo.digest) are allowed.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'supabase', 'migrations');

// pgcrypto + uuid-ossp functions that live in `extensions` on a managed project.
// (gen_random_uuid is a pg_catalog built-in and is deliberately excluded.)
const EXT_FUNCS = [
  // pgcrypto
  'gen_random_bytes', 'digest', 'hmac', 'gen_salt', 'crypt',
  'encrypt', 'decrypt', 'encrypt_iv', 'decrypt_iv',
  'pgp_sym_encrypt', 'pgp_sym_decrypt', 'pgp_sym_encrypt_bytea', 'pgp_sym_decrypt_bytea',
  'pgp_pub_encrypt', 'pgp_pub_decrypt', 'pgp_pub_encrypt_bytea', 'pgp_pub_decrypt_bytea',
  // uuid-ossp
  'uuid_generate_v1', 'uuid_generate_v1mc', 'uuid_generate_v3',
  'uuid_generate_v4', 'uuid_generate_v5',
];

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const violations = [];
for (const file of files) {
  const lines = readFileSync(join(DIR, file), 'utf8').split('\n');
  lines.forEach((line, idx) => {
    // Skip whole-line SQL comments (does not strip trailing comments, which is fine
    // — a bare call before a trailing comment should still be flagged).
    if (line.trimStart().startsWith('--')) return;
    for (const fn of EXT_FUNCS) {
      // "bare" = the function name is a call `fn(` NOT preceded by a word char or a
      // dot. A leading `.` means it is schema/column-qualified (extensions.fn,
      // pgcrypto.fn, alias.fn) and is allowed. A leading word char means it is part
      // of a longer identifier (e.g. my_digest) and is a different symbol.
      const re = new RegExp(`(?<![\\w.])${fn}\\s*\\(`);
      if (re.test(line)) {
        violations.push(
          `${file}:${idx + 1}: bare ${fn}( — must be extensions.${fn}(  ->  ${line.trim().slice(0, 120)}`,
        );
      }
    }
  });
}

if (violations.length) {
  console.error(`\nMIGRATION EXTENSION-QUALIFICATION CHECK FAILED (${violations.length}):\n`);
  for (const v of violations) console.error('  ' + v);
  console.error(
    '\nSchema-qualify each call as extensions.<fn> so a fresh managed Supabase project\n' +
    '(pgcrypto/uuid-ossp in `extensions`, off the migration search_path) can apply the chain.\n' +
    'gen_random_uuid() is a pg_catalog built-in and does not need qualification.\n',
  );
  process.exit(1);
}
console.log(`OK: all pgcrypto/uuid-ossp calls are schema-qualified across ${files.length} migrations.`);
