import "server-only";
import { createHash } from "crypto";

// PR #134. Shared helper for the client_consent_signatures rows
// written by the portal-side signConsentFormAction. Lives in
// lib/consent so the practitioner-side template management surface
// and the portal-side sign action both import the same canonical
// hash function; mismatched implementations would surface as
// spurious template-drift detections on a future verification.
//
// The hash is SHA-256 hex over the canonical concatenation:
//
//   <title>
//   \n---\n
//   <body>
//   \n---\n
//   <version>
//
// All three inputs are coerced to strings before hashing. Versions
// are stored as integers but stringified to "1", "2", ... so the
// hash is stable across UTF-8 encoding. The result is a lowercase
// 64-char hex string; the DB CHECK
// (client_consent_signatures_hash_check) only requires non-empty,
// but the table comment documents the format.

export type ConsentTemplateInput = {
  title: string;
  body: string;
  version: number;
};

export type ConsentTemplateSnapshot = {
  templateTitleSnapshot: string;
  templateBodySnapshot: string;
  templateVersion: number;
  templateHash: string;
};

// Render-side companion to buildConsentTemplateSnapshot.
//
// A surface that displays a consent template attaches the canonical hash of
// the EXACT (title, body, version) it rendered, and the browser carries that
// value back at signing time as a COMPARAND. recordConsentSignature
// re-resolves the template, recomputes the hash from its own row, and refuses
// if the two differ -- which is what stops a studio edit between render and
// submit from snapshotting text the client never read.
//
// It deliberately routes through the SAME buildConsentTemplateSnapshot the
// signing side uses. A second, separately-derived hash implementation here
// would make the comparison silently vacuous the moment either drifted.
export function withRenderedTemplateHash<T extends ConsentTemplateInput>(
  template: T,
): T & { renderedTemplateHash: string } {
  return {
    ...template,
    renderedTemplateHash: buildConsentTemplateSnapshot(template).templateHash,
  };
}

export function buildConsentTemplateSnapshot(
  input: ConsentTemplateInput,
): ConsentTemplateSnapshot {
  // Snapshots store the inputs verbatim. We do NOT trim whitespace
  // here because the snapshot must capture exactly what the client
  // saw at signing time; downstream rendering already trims for
  // display.
  const templateTitleSnapshot = input.title;
  const templateBodySnapshot = input.body;
  const templateVersion = input.version;
  const canonical =
    `${templateTitleSnapshot}\n---\n${templateBodySnapshot}\n---\n${templateVersion}`;
  const templateHash = createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex");
  return {
    templateTitleSnapshot,
    templateBodySnapshot,
    templateVersion,
    templateHash,
  };
}
