# Delta — Engineering Decisions

**Status:** Day 2 — ingestion, normalisation, detection and reconciliation verified
against the live database (`npx tsx scripts/verify-ingestion.ts`, 13/13).
**Constraint:** Solo builder, 7 days, ~56 hours.

Everything in this file is **decided**. It exists so no build hour is spent
re-deciding, and so a reader can see why the system is shaped the way it is.

---

## 1. What we are building

A revenue-recovery agent for Razorpay merchants that detects money at risk,
diagnoses why, decides whether contacting the customer is *worth it*, executes a
bounded recovery action, and measures what was actually recovered.

**The thesis, and the whole differentiator:**

> Most failed payments recover on their own. Contacting those customers earns
> zero incremental revenue at real cost. We optimise the **incremental** rupee,
> not the probability of payment.

```
uplift(a|x) = P(pay | x, action a) − P(pay | x, do nothing)
EV(a|x)     = uplift(a|x) · amount − cost(a) − λ · fatigue(x, a)
policy(x)   = argmax EV over policy-permitted actions;
              do-nothing is always in the set, at EV 0
```

Every design decision below follows from that formula. If a change would weaken
the uplift argument, it is the wrong change.

---

## 2. Non-negotiables

**Never cut these four.** They are the submission:

1. The uplift model (`lib/uplift.ts`)
2. The policy engine (`lib/policy.ts`)
3. The evaluation with a do-nothing floor and an oracle ceiling (`eval/`)
4. The audit trail

**Never fabricate.** No number appears in the UI, README, or pitch that was not
produced by a committed run over the held-out set. Read `eval/results.json`;
never type a figure by hand.

**Never fake a transaction.** Test Mode caps payment links, so part of any batch
is simulated. Every simulated row carries a `SIM` badge and a persistent banner.
Real ones carry `LIVE`.

**Never let the LLM move money.** It selects from an enum and writes prose.
Nothing else.

**Never say "retry".** There is no retry-a-failed-payment API (§3). The word must
not appear next to a Razorpay action anywhere in the product.

---

## 3. Verified Razorpay facts

Read from official documentation during Phase 0. Treat as ground truth.

### Hard constraints

| Constraint | Consequence |
|---|---|
| **No API retries a failed payment.** Payments API is capture/fetch/update only; `failed` is terminal. | Action set is link + nudge, never re-charge. |
| `POST /v1/payments/create/recurring` exists but the feature is **on-demand, activated by Razorpay Support**. | Assume unavailable. Nothing depends on it. |
| **Test Mode caps Payment Links at ~30 per business.** | Hybrid LIVE/SIM execution is mandatory, not optional. |
| **No checkout-abandonment webhook exists.** | Must be inferred from ageing orders, and labelled as inferred in the UI. |
| `GET /v1/orders` has **no `status` filter** — only `authorized`, `receipt`, `from`, `to`, `count` (max 100), `skip`, `expand[]`. | Sweep by time window with `expand[]=payments`, classify locally. |
| **`payment.failed` does not fire for all failures** — not triggered when payment fails during authorisation. | A reconciliation sweep is mandatory alongside webhooks. |
| **No idempotency keys** on Payments/Payment Links (that is a RazorpayX feature). `reference_id` *rejects* duplicates with an error rather than returning the original. | Own idempotency ledger. On a duplicate-reference error, treat as success and resolve via `GET /v1/payment_links?reference_id=…`. |
| **`notify_by` sends Razorpay's own template.** No message-body control. | Personalisation requires our own channel (Resend) carrying the `short_url`. |
| **Subscriptions do not bill automatically in Test Mode** — charges fire from a dashboard button, and card tokens live 3 days. | Subscriptions are out of scope. |
| Rate limits are real but **undocumented**; 429s expected. | Conservative fixed-rate executor with jittered backoff. |
| **Razorpay already ships** Failed Payment Recovery, Intelligent Payment Retry, and Agent Studio (Subscription Recovery, Abandoned Cart agents). | Cite them in the README. Differentiate on the decision layer, never on the action. |

### Endpoints we use

```
GET  /v1/payments                    failed-payment sweep (count max 100)
GET  /v1/payments/:id                pre-execution state guard
GET  /v1/orders?expand[]=payments    abandonment inference
GET  /v1/payments/downtimes          instrument health -> deferral rule
POST /v1/payment_links               amount, currency, expire_by (max 6mo),
                                     reference_id (<=40ch, unique), description,
                                     customer{}, notify{sms,email},
                                     reminder_enable, notes{}, callback_url
POST /v1/payment_links/:id/notify_by/:medium    medium in sms|email
POST /v1/payment_links/:id/cancel
POST /v1/invoices/:id/notify_by/:medium         issued|partially_paid only, else 400
```

Payment link statuses: `created` `partially_paid` `paid` `expired` `cancelled`

### Webhooks

Subscribed: `payment.failed` `payment.captured` `payment.authorized` `order.paid`
`payment_link.paid` `payment_link.partially_paid` `payment_link.expired`
`payment_link.cancelled` `payment.downtime.started` `payment.downtime.updated`
`payment.downtime.resolved`

- HMAC-SHA256 over the **raw unparsed body**, header `X-Razorpay-Signature`.
  Use the SDK's `validateWebhookSignature`; never hand-roll it.
- Must return **2xx within 5 seconds** or Razorpay retries with backoff for 24h,
  then deactivates the endpoint.
- Max 30 webhook URLs per mode. Test-mode setup OTP: `754081`.
- **No ordering or exactly-once guarantee.** Design for duplicates and reordering.

### Failure taxonomy — `error_reason` to class

```
TRANSIENT         gateway_technical_error, bank_technical_error, payment_timed_out
CUSTOMER_FIXABLE  payment_cancelled, authentication_failed, incorrect_cvv,
                  insufficient_funds
INSTRUMENT_DEAD   card_expired, debit_instrument_blocked,
                  debit_instrument_inactive, card_not_enrolled,
                  card_disabled_for_online_payments
DO_NOT_TOUCH      payment_risk_check_failed     -> always ESCALATE, never automate
OPAQUE            card_declined, payment_failed, transaction_limit_exceeded
```

An unmapped `error_reason` **raises**. It never defaults to a bucket, because a
wrong bucket is a wrong money decision.

---

## 4. Stack

| Layer | Choice |
|---|---|
| App | Next.js 16 App Router + TypeScript |
| UI | Tailwind + shadcn/ui |
| Tables | TanStack Table |
| Charts | Recharts — max 2 |
| DB | Supabase Postgres (**pooler** connection; direct host is IPv6-only) |
| ORM | Drizzle, with real migrations |
| Validation | Zod — one schema serves API, env, and LLM structured output |
| LLM | Vercel AI SDK `generateObject`; Groq primary, Gemini fallback |
| Payments | official `razorpay` npm SDK |
| Email | Resend |
| Scheduling | Vercel Cron |
| Retry / concurrency | `p-retry`, `p-limit` |
| Training | Python (pandas, scikit-learn), **offline only**, emits `model.json` |
| Scoring | ~40 lines of TypeScript reading `model.json`. **No Python service.** |
| Auth | **None.** Single hardcoded merchant. |

**One runtime.** TypeScript for everything in production. Python never deploys.

---

## 5. Architecture — the trust boundary

```
Webhook -> persist raw FIRST -> verify HMAC -> dedupe on event id -> 200 in <5s
Cron    -> reconciliation sweep (catches what webhooks miss)
             |
           normalise -> risk_items -> diagnose (taxonomy + LLM narrative)
             |
=========== NO LLM BELOW THIS LINE ===========
  score (uplift.ts) -> EV (ev.ts) -> policy (policy.ts) -> execute (executor.ts)
==============================================
             |
           verify via webhook -> attribute on notes.decision_id -> outcome row
```

**Degradation.** LLM down: template strings, loop unchanged. Scorer unavailable
or input out-of-distribution: `ESCALATE`, never a default probability. Razorpay
down: queue, and the idempotency ledger prevents double execution on recovery.
Database down: return non-2xx and let Razorpay's own retry carry it.

---

## 6. Action vocabulary and costs

```ts
type Action =
  | 'ISSUE_RECOVERY_LINK'   // POST /v1/payment_links          Rs 0.00
  | 'NUDGE_SMS'             // notify_by/sms                   Rs 0.20
  | 'NUDGE_EMAIL'           // notify_by/email                 Rs 0.05
  | 'DEFER'                 // no API call, reschedule         Rs 0.00
  | 'WITHDRAW'              // POST /payment_links/:id/cancel  Rs 0.00
  | 'ESCALATE_HUMAN'        // queue row                       Rs 45.00
  | 'STOP'                  // terminal, with reason           Rs 0.00
```

Costs live in typed config and are surfaced in the UI. A reader should be able to
change Rs 0.20 to Rs 2.00 and watch the policy shift.

---

## 7. Policy engine

Evaluated **after** scoring and **before** execution. Pure function, one unit test
per rule. Returns `ALLOW | DELAY | ESCALATE | STOP` plus ordered reasons.

| Rule | Default | Verdict |
|---|---|---|
| Customer opted out | — | `STOP` permanent |
| Item already paid (re-read from Razorpay before executing) | — | `STOP` |
| Duplicate idempotency key | — | `STOP` no-op |
| `error_reason = payment_risk_check_failed` | — | `ESCALATE` |
| Amount above high-value threshold | Rs 25,000 | `ESCALATE` |
| Contacts to customer in trailing 7 days | max 3 | `STOP` |
| Actions on this risk item | max 2 | `STOP` |
| Age since detection | 72 h | `STOP` window expired |
| Quiet hours IST | 21:00–09:00 | `DELAY` |
| Open downtime for the instrument | — | `DELAY` until resolved |
| Net EV below floor | Rs 5.00 | `STOP` |
| Uplift below floor | 0.03 | `STOP` would likely recover anyway |
| Daily automated spend cap | configurable | `DELAY` |
| Scorer unavailable or low confidence | — | `ESCALATE` |

Quiet hours and the fatigue cap are what the track means by compliant escalation.

---

## 8. Data model

`merchants` `customers` `webhook_events` `orders` `payments` `invoices`
`downtimes` `risk_items` `diagnoses` `scores` `decisions` `action_attempts`
`outcomes` `escalations` `contacts`

Three constraints carry the safety argument, and are enforced by the **database**
rather than by application code:

1. `webhook_events.razorpay_event_id` UNIQUE — duplicate delivery is a no-op
2. `action_attempts.idempotency_key` UNIQUE, written *before* the outbound call —
   a crash mid-flight cannot produce a second payment link
3. Partial unique index on `risk_items` where `state = 'open'` — the webhook path
   and the reconciliation path cannot open two risk items for the same entity

---

## 9. LLM boundary

**Deterministic, never a model:** all money arithmetic, probabilities, expected
value, policy verdicts, taxonomy mapping, idempotency, execution.

**LLM:** diagnosis narrative, cluster root-cause summary, schema-validated action
proposal, recovery message copy, merchant copilot.

`lib/llm.ts` returns `null` on total failure rather than throwing, which forces
every call site to have a non-LLM path.

```ts
const CHAIN = [
  groq('openai/gpt-oss-120b'),   // primary
  google('gemini-3.7-flash'),    // fallback
];
```

Verified against provider documentation on 22 Aug 2026. Both had moved since the
plan was written — `gemini-2.5-flash` is a previous generation, and
`llama-3.3-70b-versatile` is no longer in Groq's production list. Re-check before
demo day; provider catalogues change without notice.

Environment variables are `GOOGLE_GENERATIVE_AI_API_KEY` and `GROQ_API_KEY` (the
Vercel AI SDK convention, which differs from the `GEMINI_API_KEY` that Google's
own client libraries read).

**No length constraints in output schemas.** Gemini does not honour `maxLength`
in structured output: it emits a longer string and Zod then rejects the whole
response with "did not match schema". Reproduced twice against
`gemini-3.7-flash`. Truncate after parsing, never in the schema.

Groq leads the chain on measured evidence: roughly 2x faster and zero failures
across testing, against a Gemini free tier that intermittently returns capacity
errors. Our calls are short constrained classifications where latency and
reliability matter more than reasoning depth.

**Verified live on 22 Aug 2026** via `npx tsx scripts/check-providers.ts`:
`gemini-3.7-flash` 2.6s, `openai/gpt-oss-120b` 1.2s, both returning valid
structured output. Gemini's free tier intermittently returns "experiencing high
demand" — which is precisely why the fallback chain exists rather than being
decoration.

**Cache LLM output by `(taxonomy_class, amount_band, risk_class)`, not per item.**
A 200-item batch then makes roughly 8 calls instead of 200. Items in the same
class genuinely share a diagnosis, so this is also better output, not just cheaper.

Record every disagreement between the LLM's proposal and the EV ranking — it is
one column, and it makes the model's role legible.

---

## 10. Model

Two arms: contact vs do-nothing. Logistic regression with isotonic calibration on
validation. Do not move to gradient boosting unless held-out AUC-PR improves
materially — interpretability is worth more here than a small lift, because the
EV formula multiplies probability by rupees and a miscalibrated model produces
confidently wrong money decisions.

Features: amount, method, bank, `error_source`/`step`/`reason`, hours since
failure, hour-of-day, weekday, days-to-payday, customer success and failure
counts, tenure, LTV band, prior contacts in window, downtime-active flag.

Splits grouped by **customer and time simultaneously**: train days 1–60, validate
61–75, test 76–90, with no customer crossing the boundary. The test split is
hashed, sealed, and opened exactly once.

Comparators: `B0` do-nothing (floor) · `B1` contact-everything · `B2` day-0/3/7
ladder · `ORACLE` perfect foresight (ceiling). Report percentage of oracle
captured, with bootstrap 95% confidence intervals.

---

## 11. Repo layout

```
app/api/webhooks/razorpay/route.ts   verify -> persist -> 200 fast
app/api/cron/reconcile/route.ts      Vercel Cron target
app/api/batch/execute/route.ts       the Execute button
app/(dash)/                          overview, queue, decision drilldown, evaluation
lib/uplift.ts    * authored + tested
lib/policy.ts    * authored + tested
lib/ev.ts        * authored + tested
lib/taxonomy.ts  lib/executor.ts  lib/razorpay.ts  lib/llm.ts  lib/db/schema.ts
eval/generate.py *   eval/train.py *   eval/harness.py *
eval/results.json    the only source of every number claimed
eval/model.json      coefficients + isotonic calibration table
```

`*` = authored from scratch and tested. Everything else is assembled from
libraries — a hand-rolled HMAC check or bespoke data table earns nothing.

---

## 12. Day plan and gates

| Day | Work | Gate |
|---|---|---|
| 1 | Verify account reality, scaffold, schema, webhook receiver, **deploy** | Real test event stored in production |
| 2 | Ingestion, normalisation, detection, reconciliation | Suppressed webhook still detected by reconciliation, exactly once |
| 3 | `generate.py`, splits, `harness.py`, four baselines | Baselines with CIs exist **before any model**; oracle gap wide enough to win |
| 4 | Taxonomy, `train.py`, `uplift.ts`, `llm.ts` | TS scoring matches Python to 6dp on fixtures |
| 5 | `ev.ts`, `policy.ts`, `executor.ts`, attribution, email | Kill mid-batch, restart, zero duplicate links |
| 6 | Dashboard: overview, queue, drilldown, evaluation | Every number traces to a row |
| 7 | Failure drills, freeze, final eval, README, rehearse | 3 clean runs under 4:30 |

**Cut ladder**, in order, without deliberating: copilot, LLM narrative, abandoned
checkout, live payment beat, personalised email, drills 5→3, evaluation page.
Never the four in §2.

---

## 13. Open items

- [x] Product name — **Delta**. Names the incremental rupee.
- [x] Payment-link budget: 0 of ~30 used at start
- [x] Invoices **is** enabled on the test account (probed 22 Aug)
- [x] Deployed and healthy; handler verified with a signed synthetic delivery
- [ ] A real Razorpay `payment.failed` observed in production
