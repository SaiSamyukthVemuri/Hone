# Recording a studio sender's STOP preflight (HON-50 G6)

A studio listed in `SMS_STUDIO_ROUTING_STUDIO_IDS` sends **nothing** from its own number until its sender has a recorded STOP preflight that passes, is current, and covers the complete version-1 checklist (migration `0230`; enforced in `lib/sms/send-time-route.ts`). This runbook records that preflight with the operator script `scripts/sms/record-stop-preflight.mjs`.

The script never decides a check itself. It validates the facts you gather, runs the app's own `evaluateInboundStopPreflight`, and, only with `--record`, records exactly that evaluator's output through `record_studio_sms_stop_preflight`.

## When this is allowed

- **A local Supabase (loopback address):** any time, for testing.
- **Any non-local target, staging included:** the script treats every non-loopback Supabase as hosted. It refuses unless you pass `--allow-hosted` **and** set `HONE_STOP_PREFLIGHT_HOSTED_APPROVED=yes`. Setting those is an explicit statement that this run is approved:
  - by Sam, for the production cutover;
  - by the migration coordinator, for a named staging stack.
- **Production** is never targeted as part of engineering work.
- **Prerequisite:** `0229` and `0230` are applied to the target database. Before that, the snapshot has no `stop_preflights` and every studio-routed send refuses.

## 1. Gather the facts (read-only)

Write a JSON file. **Never put a secret in it.** The auth token is reported only as `authTokenSet: true/false`. A file carrying anything that looks like a token, secret, password or API key is refused outright.

**Identity comes from the database, never from this file.** The script reads the studio's single active sender (its number and Messaging Service), the routed From, and the service-to-studio mapping. If the file carries `routedFromNumber`, `mappedStudioId` or `expectedStudioId`, they are ignored and listed as `ignored`.

**The service facts must say which service and number they describe.** `service.sid` and `service.checkedNumber` label the Messaging Service and number you read them from, and both must equal the database sender's. If either label is missing or names another service or number, every `service.*` fact and the `optOutConfiguration` (also a per-service setting) are dropped:
- the checks they feed are `unknown`;
- the run is not ready;
- `malformed` lists `service_evidence_unlabelled` or `service_evidence_for_another_sender`.

This stops facts copied from another studio's service from certifying this one.

| Fact | Where it comes from |
|---|---|
| `deployment.webhookBaseUrl` | Production's `TWILIO_WEBHOOK_BASE_URL` (the deployment's settings, not your machine). |
| `deployment.authTokenSet` | Whether production's `TWILIO_AUTH_TOKEN` is set. Presence only. |
| `deployment.appOrigin` | Production's `NEXT_PUBLIC_APP_ORIGIN`. |
| `deployment.accountSid` | The Twilio account whose token production holds. |
| `signatureProof` | The newest signature-verified delivery callback time, and when the current token and base became active. |
| `endpointProbe` | A GET of `<base>/api/twilio/inbound-sms` from outside: `{ "status": 405, "redirectedTo": null }` is the route. |
| `service.sid`, `service.checkedNumber` | The Messaging Service (`MG…`) and number (E.164) the facts below were read from. Both must equal the studio's live sender. |
| `service.*` | That Messaging Service and number as Twilio reports them: inbound URL and method, the number-level webhook flag, number webhook, application, fallbacks, account, and (number-level mode only) the sender pool. |
| `webhookRules`, `webhookPropagation`, `staticProxyEnabled`, `edgeZoneCatalog` | The account's Webhooks configuration (Rules and Settings, including each Setting's `settingType` SYSTEM/CUSTOMER), Rule Operations, Static Proxy, edge zones. |
| `liveStopObservation` | One approved live STOP texted **to the studio's number**: whether it reached the route, the route's status, whether the phone-wide opt-out was stamped, its time, and the signed request's `To` (E.164) and `MessagingServiceSid` (`MG…`). |
| `optOutConfiguration` | Whether the service drops opt-out keyword messages, and when that setting last changed. |
| `currentActivation` | When the production handler deployment and the newest database migration became active. |

Validation is strict. A field that is missing or malformed counts as **not read**: the checklist item it feeds is `unknown`, never `pass`, and its path is listed under `malformed`. For the live STOP:
- `To` must be canonical E.164;
- the SID must be an `MG` SID;
- the time must be a strict ISO 8601 instant with a zone (`2026-10-12T12:00:00Z` or `…+05:30`), a real calendar date, and not in the future (the same applies to every time in the file);
- the status must be an integer from 100 to 599;
- the booleans must be real booleans.

Template (fill in every value; this one is illustrative only):

```json
{
  "factsVersion": 1,
  "deployment": { "webhookBaseUrl": "https://<production-origin>", "authTokenSet": true, "appOrigin": "https://<production-origin>", "accountSid": "AC<32 hex>" },
  "signatureProof": { "lastVerifiedCallbackAt": "<ISO>", "credentialsActiveSince": "<ISO>" },
  "endpointProbe": { "status": 405, "redirectedTo": null },
  "service": { "sid": "MG<32 hex, the studio's service>", "checkedNumber": "+1<the studio's number>", "inboundRequestUrl": "https://<origin>/api/twilio/inbound-sms#<overrides>", "inboundMethod": "POST", "useInboundWebhookOnNumber": false, "numberSmsUrl": null, "numberSmsApplicationSid": null, "accountSid": "AC<32 hex>", "fallbackUrl": null, "fallbackMethod": null },
  "webhookRules": { "matched": false },
  "staticProxyEnabled": false,
  "webhookPropagation": { "ruleOperationStatuses": ["COMPLETED"], "secondsSinceLastConfigChange": 3600 },
  "liveStopObservation": { "reachedRoute": true, "routeStatus": 200, "phoneWideOptOutStamped": true, "observedAt": "<ISO>", "toNumber": "+1<number>", "messagingServiceSid": "MG<32 hex>" },
  "optOutConfiguration": { "dropsKeywordMessages": false, "lastChangedAt": "<ISO>" },
  "currentActivation": { "handlerDeployedAt": "<ISO>", "databaseMigratedAt": "<ISO>" }
}
```

## 2. Dry run (the default; writes nothing)

Set the target once for the shell session, so that the dry run and the record step (section 3) both reach the same database:

```sh
export NEXT_PUBLIC_SUPABASE_URL=<target>
export SUPABASE_SERVICE_ROLE_KEY=<from your secret store>
node scripts/sms/record-stop-preflight.mjs --studio <studio uuid> --facts ./stop-facts.json
```

**Hosted (production) target, for a Sam-approved cutover only.** Both gates are required on every command, the dry run included:

```sh
export HONE_STOP_PREFLIGHT_HOSTED_APPROVED=yes
node scripts/sms/record-stop-preflight.mjs --studio <studio uuid> --facts ./stop-facts.json --allow-hosted
```

Keep these exported until the record step in section 3 is done; the clean-up comes after it.

The output is one JSON line with codes and ids only:
- `result`, `ready` and `blockers`;
- every checklist `id` with `pass` / `fail` / `unknown`;
- the `malformed` and `ignored` paths.

It never contains a phone number, a SID, a URL or a token. Fix the facts, or the configuration, until `ready` is `true`.

## 3. Record

In the same shell, with the target still exported from section 2:

```sh
node scripts/sms/record-stop-preflight.mjs --studio <studio uuid> --facts ./stop-facts.json --record --context cutover
```

For the hosted cutover, add the same gates as the dry run:

```sh
node scripts/sms/record-stop-preflight.mjs --studio <studio uuid> --facts ./stop-facts.json --record --context cutover --allow-hosted
```

(`HONE_STOP_PREFLIGHT_HOSTED_APPROVED=yes` must still be exported.) Without the target variables the script answers `target_refused` (`no_supabase_url` or `no_service_role_key`). A hosted target without both gates answers `target_refused` (`hosted_not_approved`).

- `--context` is `evidence` or `cutover`.
- `--credentials-epoch <value>` records a non-secret epoch (it is used only if Sam chooses the epoch option for token rotation).
- A not-ready result is recorded too. It replaces any earlier ready record, which is the safe direction.

| `result` | Meaning |
|---|---|
| `recorded` | The evaluator's checklist is the sender's current preflight. |
| `record_refused` + `preflight_changed` | Another recording landed after this run read the record. Re-run; nothing was overwritten. |
| `record_refused` + `sender_changed` / `no_live_sender` | The sender's number or state changed. Re-gather the facts. |
| `outcome_unknown` | The database's answer was lost; the write may have committed. Re-run the dry run to see the current state before recording again. |
| `cannot_record_without_webhook_base` | `deployment.webhookBaseUrl` is missing or malformed. |
| `snapshot_unreadable`, `no_active_sender`, `ambiguous_active_sender`, `sender_identity_missing` | Nothing was evaluated or recorded. |
| `facts_refused`, `target_refused`, `invalid_arguments` | Nothing was read or written. |

**Clean up, only once recording is finished:**

```sh
unset HONE_STOP_PREFLIGHT_HOSTED_APPROVED SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_URL
```

## Afterwards

- **Re-record** after any change to the number, the Messaging Service, the inbound webhook, the Webhooks configuration, the opt-out setting, the webhook base, or a deployment or migration of the STOP path. The send path treats a preflight checked before the sender's provisioning, or against another webhook base, as not current.
- **Auth token rotation:** the send path cannot detect it. Re-record after every rotation (pending Sam's decision on the epoch option).
