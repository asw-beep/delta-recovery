# Status — start here

Last updated: **29 Aug 2026, ~16:05 IST**. Mid-Day-7.

Read this first when resuming. `DECISIONS.md` has the locked architecture;
`docs/difficulties.md` has the submission writeup material.

---

## Where we are

**The product is feature-complete.** Detection, diagnosis, scoring, EV, policy,
execution, attribution, the LLM degradation analyst, five dashboard surfaces,
the evaluation, the escalation queue and the README all exist and are verified
against the live database. What remains is Day 7 process — drills, freeze,
rehearsal — plus one performance problem.

| Day | Work | State |
|---|---|---|
| 1–5 | Scaffold → executor, attribution | done |
| 6 | LLM degradation analyst, dashboard | done |
| 7 | Drills, freeze, final eval, rehearsal | **not started** |

**Verification suites** (all against the live database):

```
npx vitest run                        35 unit tests
npx tsx scripts/verify-ingestion.ts   24 checks
npx tsx scripts/verify-executor.ts    17 checks, incl. 10 concurrent executions
npx tsx scripts/verify-attribution.ts 10 checks, real recovered money
npx tsx scripts/verify-degradation.ts  8 checks, live LLM
npx tsx scripts/check-providers.ts    Groq + Gemini health
```

---

## Do this first

**1. After 09:00 IST — run a live batch.** Quiet hours (21:00–09:00) turns every
otherwise-allowable item into `DELAY`, which is correct but means `ALLOW` and
live execution are unreachable at night.

```bash
npx tsx scripts/run-batch.ts --dry --budget 50      # 27 ALLOW as of 29 Aug
npx tsx scripts/run-batch.ts --budget 50 --live 2   # real links + SIM remainder
```

**Done 29 Aug** — a second attributed recovery exists (₹16,998 total, 2
outcomes). The headline gap is closed.

**1. Day 7 proper** — failure drills (LLM down, Razorpay down, database down,
kill mid-batch), final eval run and freeze, README pass, rehearsal, backup
recording.

**2. Update the README.** It still says ₹8,499 recovered in one outcome. The
figure is now ₹16,998 across two, and the second one is the better story because
it traverses the whole loop in one sitting.

---

## What 29 Aug changed

**Batch performance: 136s → ~6s.** The suspicion recorded here was per-item LLM
calls; that was wrong — the degradation analyser always made one clustered call
per batch. It was entirely serial database round-trips: ~8 per item against a
pooler measured at **76.5 ms**, which is the 136 seconds almost exactly. All the
per-item reads are now one preload (`loadPolicyInputs`), and every write nothing
reads until the batch ends goes out in one statement. Only an item about to
execute still writes inline, because the idempotency claim must precede the
outbound call. See `docs/difficulties.md` #14 — including the trap: two of those
preloaded values are the fatigue and per-item action caps, which had to stay
live in memory or they would stop binding *within* a run.

**Every downtime record ever ingested was still open.** 18 rows, all with `end`
NULL, one running since April. `GET /v1/payments/downtimes` returns only what is
down *now* — a resolved outage stops appearing rather than being closed — and
the sweep never asked what had stopped being returned. Two rules read that table
and both fail open: the policy deferral, and the degradation analyser's
corroboration check, which is the evidence gate that decides whether the LLM may
defer a cluster. It had been rubber-stamping card and netbanking outage claims
since the table was first populated. The sweep now closes what the endpoint stops
reporting (it closed 12), and `fetchDowntimes` returns `null` rather than `[]` on
failure so a network blip cannot resolve every live outage. `docs/difficulties.md` #15.

**A staleness bound on the downtime rule.** Razorpay leaves records open
indefinitely — this account still actively reports card, UPI and netbanking as
down, one since 30 July. Without a bound that DELAYed 60 of 107 open items
(56%, ₹2,55,744) forever. `DEFAULT_POLICY.staleDowntimeHours = 24`; beyond it a
record is treated as unclosed rather than as a live outage, and the reason is
recorded on the decision. The degradation analyser applies the same bound.

**Demo data reloaded, smaller and current.** The old set had aged out — 96 of
107 items were past the 72h recovery window, so a batch produced 88 STOPs and 4
ALLOWs. Purged and reloaded at 44% (`--keep-orders 14`), sampling whole orders so
self-recovery pairs survive; the rate re-anchored to exactly the 25% target and
all five taxonomy classes, the high-value escalations, fraud flags and fatigue
cases are intact. **51 open items, 27 ALLOW, ₹84,025 targeted.**

**One reporting bug, mine, caught same day.** `blockedByRule` attributed a stop
to `reasons[0]`, which was safe only while the policy engine pushed exactly one
reason. The staleness note broke that invariant and misattributed 4 stops. It now
uses the last reason, which is the deciding one by construction.

**The sweep could never close an item the agent had touched.**
`closeSettledRisks` filtered `state = 'open'`, but the executor sets
`in_progress` the moment it acts — so acted-on items, the population most likely
to settle, could never be closed and accumulated in limbo inflating
amount-at-risk. Found by running the live loop. Fixing it also required splitting
the classifier: "did we act?" is not "did we cause it?", and the old rule would
have booked money from an unrelated link as `recovered_after_intervention`.
`attributeRecovery` is now the only path allowed to write that reason; everything
else closes as **`settled_unattributed`** — real money, no claim on it.
`docs/difficulties.md` #16.

**Live loop exercised end to end.** A real failure was driven through
`make-test-link` → `payment.failed` webhook → risk item opened via webhook in 4s
→ ranked #1 at EV ₹1,918 (above an ₹18,750 invoice, which is the thesis visible
in the ranking) → real recovery link minted carrying its decision id. The
fatigue cap also fired twice on contacts sent earlier *in the same batch*,
confirming the in-memory counters from the perf refactor still bind.

---

## Live facts

| | |
|---|---|
| Repo | `asw-beep/delta-recovery` (private) |
| Deployment | `https://delta-recovery-aswin-s-projects-c3bce5f6.vercel.app` |
| Routes | `/` `/queue` `/escalations` `/evaluation` `/decisions/[id]` `/api/health` — all 200 |
| Database | Supabase pooler, `ap-southeast-1`, 15 tables + 4 migrations |
| Payment links | 2 minted by the agent + 1 test link on 29 Aug. Razorpay's own list endpoint returns 0 even over 90 days, so it cannot be used to check the budget — track it here by hand |
| Recovered | **₹16,998** across 2 attributed outcomes (23 Aug, 29 Aug) |

**Database contents** (29 Aug, after the reload and the live batch):

```
risk_items     61   26 open · 26 in_progress · 9 recovered · 41 synthetic
  closed as: self_recovered_without_intervention  6
             recovered_after_intervention         2   <- the only ones we claim
             settled_unattributed                 1   <- acted, money came, no proof
escalations   11 open
outcomes      2 recovered, ₹16,998
attempts      2 live · 27 sim
```

The 26 `in_progress` are the SIM contacts from the live batch awaiting an
outcome. They still count toward amount-at-risk, which is correct.

The synthetic:real ratio is now **41:15** rather than 97:15. Note that trimming
alone cannot make real traffic dominate — going below ~15 synthetic would destroy
the volume that makes ranking meaningful. If the overview still reads as a
synthetic product on demo day, the fix is defaulting the queue to live-only, not
cutting further.

**Everything works but nothing is running locally** — the deployment and the
local machine share one Supabase database, so a script run locally is
immediately what the deployed dashboard serves. There is no staging. Anything
run against the database is what a judge would see.

---

## What today changed

**Money recovered, measured.** ₹8,499 traced end to end: decision → link
carrying `notes.decision_id` → HMAC-verified `payment_link.paid` → outcome →
risk item closed. `scripts/verify-attribution.ts` re-proves it in one command.

**Credit declined twice.** ₹32,490 arrived on a link the agent had never
messaged anyone about; both items closed `self_recovered_without_intervention`
and contributed nothing to the recovered figure.

**Reconciliation had never worked** (difficulty #13). Three bugs in one path,
deployed since day 1 and called nightly: `expand[]=payments` returns a collection
not an array; a JS `Date` interpolated into a `sql` template; and
`orderAlreadyPaid` joined through a foreign key that is null for
`payment.failed`, so the sweep re-opened cases whose money had already arrived.
`verify-ingestion.ts` stayed 24/24 green throughout — it tests the opener, and
nothing tested the sweep around it.

**Two stopping rules had been quietly disarmed.** Customer identity keyed email
before phone, so one person became two rows and the fatigue cap stopped binding.
And a failure on our own recovery link opened a fresh item with zero prior
actions, so the per-item action cap reset every cycle. Risk items now carry
`parent_risk_item_id` and the count walks the chain.

**Escalations have somewhere to go.** `/escalations` lists open cases
biggest-money-first; resolving asks what you did *and* whether it needed a human
at all, which makes escalation precision a number rather than a claim.

**Synthetic traffic loaded and labelled.** 97 items across all three risk
classes, every row marked `SYNTH` with a permanent banner. See
`docs/synthetic-data-spec.md`; `scripts/load-synthetic.ts --purge` removes it all
in one command.

---

## Open judgement calls

**The dashboard is 41 synthetic to 15 real.** Reloaded smaller on 29 Aug. Still
synthetic-dominated, and trimming further cannot fix that without destroying the
volume ranking needs — if it matters on the day, default the queue to live-only.

**Overdue receivables exist only as synthetic data.** Razorpay refuses a
backdated `expire_by`, so this class cannot be produced on the real account at
all. Either say so plainly in the demo or lean on the evaluation for it.

**One order can be counted twice** — as a `failed_payment` and again as an
`abandoned_checkout` — inflating amount-at-risk. Not yet addressed.

**The evaluation still rests on our own generator.** Publish the generating
process prominently and show where the agent loses. Unchanged from before.

---

## Things not to relearn

- **No Razorpay API retries a failed payment.** Recovery means a new link.
- **Supabase direct host is IPv6-only** — use the pooler, username
  `postgres.<ref>`, `@` encoded as `%40`.
- **Gemini ignores `maxLength`** in structured output. Truncate after parsing.
- **`4111 1111 1111 1111` is an international card** and this account is
  domestic-only. The domestic success card is **`4100 2800 0000 1007`**; Razorpay
  publishes one card per error reason (see `docs/status.md` history or the
  test-card docs) which generates real failures at no link-budget cost.
- **UPI is not enabled** on this account (`upi: false`). Cards, netbanking,
  wallets and paylater are.
- **`expand[]=payments` returns a collection**, not an array.
- **`GET /v1/payments/downtimes` reports only what is down right now.** A
  resolved outage stops appearing rather than being returned closed, so the
  sweep must close whatever it stops seeing. Razorpay also leaves records open
  indefinitely — this account has reported card down since 30 July — which is
  why `staleDowntimeHours` exists.
- **A JS `Date` in a drizzle `sql` template** throws in postgres-js. Use `lt()`.
- **Environment variables do not trigger a Vercel rebuild.** Redeploy after
  changing them.
- **Vercel Deployment Protection blocks webhooks** with a 401. Must stay off.
- **`RESEND_API_KEY` is missing in Vercel production.** Nothing breaks — nudges
  use Razorpay's own `notify_by` — but the personalised email path would degrade.

---

## Recommended difficulty for the submission writeup

**#13 — reconciliation had never worked.** Three bugs in a safety mechanism that
had been green in CI and returning HTTP 200 nightly since day 1, found only by
running it by hand. The lesson generalises: a scheduled job reporting success is
not evidence it did anything, and the tested unit was fine while the path around
it had never run.

Runner-up: **#11**, a STOP decision that sent a real payment link. **#2** — the
thesis failing its own evaluation on Day 3 — remains the most intellectually
honest story.
