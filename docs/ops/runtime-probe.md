# Runtime probe — `GET /api/admin/runtime`

HON-57. A platform-operator read of the Node version that actually served a
production request, for CVE-2026-111497 (Node.js Brotli decoder out-of-bounds
write; fixed in Node 22.23.4, 24.22.1 and 26.12.1).

The probe is a diagnostic, not a patch. On Vercel the vulnerability is closed
only by the managed runtime update. Nothing this route returns changes that.

## Who can call it

Only a signed-in user whose email is on the `ADMIN_EMAILS` allowlist, through
`isAdmin` in `lib/admin.ts`, the same gate as `/admin`. There is no new
allowlist, role or environment variable. In production an unset or empty
`ADMIN_EMAILS` refuses everyone.

The handler answers every refusal the same way: `404`, empty body, no-store.
That covers a non-admin, a user with no email, an auth error returned by
`getUser`, and anything thrown while resolving the user. A refusal never
carries version metadata or exception text.

The middleware runs first (`middleware.ts` → `lib/supabase/middleware.ts`). It
is pinned by `tests/security/admin-runtime-probe.test.ts`:

| Caller | What actually happens |
| -- | -- |
| Anonymous | `307` same-origin redirect to `/login`. The handler never runs. |
| Signed in, no usable studio | `307` to `/no-access`. The handler never runs. |
| Signed in, one active studio (or a valid selected-studio cookie), not on the allowlist | Reaches the handler, which returns `404`, empty body. |
| Signed in, one active studio (or a valid selected-studio cookie), on the allowlist | `200` JSON. |

The middleware's operator carve-out covers only `/admin` paths, not
`/api/admin`. An operator who is not an active practitioner in exactly one
studio, and has no valid selected-studio cookie, is sent to `/no-access` and
cannot read the probe. Use an operator session that has a usable studio.

`middleware.ts` declares no `runtime`, so on Next 15.5 it runs in the Edge
runtime by default. That is a source-level reading, not an observation. The
probe reports the Node function runtime only, never the middleware's.

## Response contract

`200` with exactly these seven keys and nothing else:

| Key | Source |
| -- | -- |
| `node` | `process.version` |
| `brotli` | `process.versions.brotli`, or `null` |
| `env` | `VERCEL_ENV`, or `null` |
| `deploymentId` | `VERCEL_DEPLOYMENT_ID`, or `null` |
| `region` | `VERCEL_REGION`, or `null` |
| `commitSha` | `VERCEL_GIT_COMMIT_SHA`, or `null` |
| `observedAt` | server time of the read, ISO 8601 |

Every response, `200` or `404`, carries `Cache-Control: no-store, no-cache,
max-age=0, must-revalidate`, `CDN-Cache-Control: no-store` and
`Vercel-CDN-Cache-Control: no-store`. The route is `runtime = "nodejs"`,
`dynamic = "force-dynamic"`, `revalidate = 0`.

## Verification procedure

Run it against the deployment that is serving production at the time. Earlier
deployment ids and commits are dated evidence, not the target.

1. Read the current production deployment independently, for example with
   Vercel `get_deployment` for the production domain. It must show
   `state=READY`, `target=production`, and a `githubCommitSha` that contains
   this route. Record the deployment id and `githubCommitVerification`.
2. Anonymous request, no cookies: expect a `307` to `/login` on the same
   origin, with no runtime metadata in the response. A `404` with an empty
   body is the other safe answer. Any other status or body is a failure,
   not a pass.
3. A signed-in studio owner who is not on the allowlist: expect `404` with an
   empty body.
4. An operator session (see the middleware note above): expect `200` JSON.
   Record every field.
5. Repeat step 4 at least five times, spaced over several minutes. Record
   `node`, `observedAt` and `deploymentId` for each sample.

Five samples may all be served by the **same** function instance. They are
repeated readings, not evidence that more than one instance was observed.

## Observation record

Empty until a real read on an authorized deployment.

| Field | Value |
| -- | -- |
| Production deployment id (step 1) |  |
| Commit SHA / githubCommitVerification (step 1) |  |
| Payload `deploymentId` / `region` / `commitSha` (or `null`) |  |
| Anonymous result |  |
| Studio-owner result |  |
| Operator samples (`observedAt`, `node`, `deploymentId`) |  |
| Lowest `node` observed |  |
| `brotli` observed |  |
| Sample status (see below) |  |
| Deployment / fleet status | UNVERIFIED unless the rule below is met |
| Recorded by, date |  |

## What a reading proves

A `200` proves that the function instance which served **that** request ran
the returned `node` version at `observedAt`.

If `deploymentId`, `region` or `commitSha` is `null`, the payload binds the
reading to no deployment, region or commit. Record which independent binding
you have (step 1, and the domain you called) and what remains unknown.

A reading does not prove any of these:

- other instances of the same deployment;
- other regions;
- other deployments, such as previews or instant-rollback candidates;
- the Edge middleware runtime or the build container;
- that the version holds through Vercel's managed rollout;
- that no exploitation happened earlier.

Sending `Accept-Encoding` without `br` on outbound requests narrows one path
into the Brotli decoder. It is not proven to be a complete mitigation, and it
does not stand in for the patched runtime.

## Classification

Compare versions numerically, major-aware, never as strings. The fixed release
for each line:

| Major | Fixed at |
| -- | -- |
| 22 | 22.23.4 |
| 24 | 24.22.1 |
| 26 | 26.12.1 |

**Sample status**, for each `200` sample:

- **OBSERVED PATCHED**: the major is 22, 24 or 26, and the version is at or
  above that line's fixed release. This holds for that invocation only.
- **OBSERVED UNPATCHED**: the major is 22, 24 or 26, and the version is below
  that line's fixed release. One such sample from the serving deployment
  establishes OBSERVED UNPATCHED.
- A major with no fixed release in the advisory is not OBSERVED PATCHED.
  Record it as OBSERVED UNPATCHED when the advisory lists that line as
  affected, and UNVERIFIED otherwise.

**Deployment or fleet status** stays **UNVERIFIED**, even when every sample is
OBSERVED PATCHED. Closing it needs evidence that reaches beyond the sampled
invocations, such as a dated written Vercel statement that explicitly covers
this deployment.

## Out of scope

- The CI Node version. It is tracked separately.
- Host Node versions. Earlier OPS reported that patched 22.23.4 and 24.22.1
  binaries are installed. The versions of the running processes, and whether
  they were restarted, remain unverified. This probe says nothing about any
  host.
- Asking Vercel for written confirmation. That is a separate operator action.
