# Recording a studio sender's STOP preflight (HON-50 G6)

A studio listed in `SMS_STUDIO_ROUTING_STUDIO_IDS` sends **nothing** from its own number until its sender has a recorded STOP preflight that passes, is current, and covers the complete version-1 checklist (migration `0230`; enforced in `lib/sms/send-time-route.ts`). This runbook records that preflight with the operator script `scripts/sms/record-stop-preflight.mjs`.

The script never decides a check itself. It validates the facts you gather, runs the app's own `evaluateInboundStopPreflight`, and, only with `--record`, records exactly that evaluator's output through `record_studio_sms_stop_preflight`.

## When this is allowed

- **Local and staging stacks:** any time, for testing.
- **Production (hosted):** only for a cutover Sam has approved. The script refuses a hosted Supabase unless you pass `--allow-hosted` **and** set `HONE_STOP_PREFLIGHT_HOSTED_APPROVED=yes`. Production is never targeted as part of engineering work.
- **Prerequisite:** `0229` and `0230` are applied to the target database. Before that, the snapshot has no `stop_preflights` and every studio-routed send refuses.

## 1. Gather the facts (read-only)

Write a JSON file. **Never put a secret in it.** The auth token is reported only as `authTokenSet: true/false`. A file carrying anything that looks like a token, secret, password or API key is refused outright.

**Identity comes from the database, never from this file.** The script reads the studio's single active sender (its number and Messaging Service), the routed From, and the service-to-studio mapping. If the file carries `service.sid`, `service.checkedNumber`, `routedFromNumber`, `mappedStudioId` or `expectedStudioId`, they are ignored and listed as `ignored`.

| Fact | Where it comes from |
|---|---|
| `deployment.webhookBaseUrl` | Production's `TWILIO_WEBHOOK_BASE_URL` (the deployment's settings, not your machine). |
| `deployment.authTokenSet` | Whether production's `TWILIO_AUTH_TOKEN` is set. Presence only. |
| `deployment.appOrigin` | Production's `NEXT_PUBLIC_APP_ORIGIN`. |
| `deployment.accountSid` | The Twilio account whose token production holds. |
| `signatureProof` | The newest signature-verified delivery callback time, and when the current token and base became active. |
| `endpointProbe` | A GET of `<base>/api/twilio/inbound-sms` from outside: `{ "status": 405, "redirectedTo": null }` is the route. |
| `service.*` | The studio's Messaging Service and number as Twilio reports them: inbound URL and method, the number-level webhook flag, number webhook, application, fallbacks, account, and (number-level mode only) the sender pool. |
| `webhookRules`, `webhookPropagation`, `staticProxyEnabled`, `edgeZoneCatalog` | The account's Webhooks configuration (Rules and Settings, including each Setting's `settingType` SYSTEM/CUSTOMER), Rule Operations, Static Proxy, edge zones. |
| `liveStopObservation` | One approved live STOP texted **to the studio's number**: whether it reached the route, the route's status, whether the phone-wide opt-out was stamped, its time, and the signed request's `To` (E.164) and `MessagingServiceSid` (`MG…`). |
| `optOutConfiguration` | Whether the service drops opt-out keyword messages, and when that setting last changed. |
| `currentActivation` | When the production handler deployment and the newest database migration became active. |

Validation is strict. A field that is missing or malformed counts as **not read**: the checklist item it feeds is `unknown`, never `pass`, and its path is listed under `malformed`. For the live STOP:
- `To` must be canonical E.164;
- the SID must be an `MG` SID;
- the time must parse and must not be in the future;
- the status must be an integer from 100 to 599;
- the booleans must be real booleans.

Template (fill in every value; this one is illustrative only):

```json
{
  "factsVersion": 1,
  "deployment": { "webhookBaseUrl": "https://<production-origin>", "authTokenSet": true, "appOrigin": "https://<production-origin>", "accountSid": "AC<32 hex>" },
  "signatureProof": { "lastVerifiedCallbackAt": "<ISO>", "credentialsActiveSince": "<ISO>" },
  "endpointProbe": { "status": 405, "redirectedTo": null },
  "service": { "inboundRequestUrl": "https://<origin>/api/twilio/inbound-sms#<overrides>", "inboundMethod": "POST", "useInboundWebhookOnNumber": false, "numberSmsUrl": null, "numberSmsApplicationSid": null, "accountSid": "AC<32 hex>", "fallbackUrl": null, "fallbackMethod": null },
  "webhookRules": { "matched": false },
  "staticProxyEnabled": false,
  "webhookPropagation": { "ruleOperationStatuses": ["COMPLETED"], "secondsSinceLastConfigChange": 3600 },
  "liveStopObservation": { "reachedRoute": true, "routeStatus": 200, "phoneWideOptOutStamped": true, "observedAt": "<ISO>", "toNumber": "+1<number>", "messagingServiceSid": "MG<32 hex>" },
  "optOutConfiguration": { "dropsKeywordMessages": false, "lastChangedAt": "<ISO>" },
  "currentActivation": { "handlerDeployedAt": "<ISO>", "databaseMigratedAt": "<ISO>" }
}
```

## 2. Dry run (the default; writes nothing)

```sh
NEXT_PUBLIC_SUPABASE_URL=<target> SUPABASE_SERVICE_ROLE_KEY=<from your secret store> \
  node scripts/sms/record-stop-preflight.mjs --studio <studio uuid> --facts ./stop-facts.json
```

The output is one JSON line with codes and ids only:
- `result`, `ready` and `blockers`;
- every checklist `id` with `pass` / `fail` / `unknown`;
- the `malformed` and `ignored` paths.

It never contains a phone number, a SID, a URL or a token. Fix the facts, or the configuration, until `ready` is `true`.

## 3. Record

```sh
node scripts/sms/record-stop-preflight.mjs --studio <studio uuid> --facts ./stop-facts.json --record --context cutover
```

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

## Afterwards

- **Re-record** after any change to the number, the Messaging Service, the inbound webhook, the Webhooks configuration, the opt-out setting, the webhook base, or a deployment or migration of the STOP path. The send path treats a preflight checked before the sender's provisioning, or against another webhook base, as not current.
- **Auth token rotation:** the send path cannot detect it. Re-record after every rotation (pending Sam's decision on the epoch option).
