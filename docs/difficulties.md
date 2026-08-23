# Difficulties log

A running record of problems hit during the build, how they were found, and what
fixed them. Written as they happened so the submission writeup can pick from
real material rather than reconstructed memory.

Ranked recommendation at the bottom.

---

## 1. The core mechanic we planned around does not exist

**Day 0, research.**

The original product concept was an agent that retries failed payments
intelligently. Reading Razorpay's Payments API reference end to end, the only
documented operations are capture, fetch and update. **There is no endpoint that
re-attempts a failed payment.** A payment in `failed` is terminal. The only true
server-side re-charge is `POST /v1/payments/create/recurring`, which needs a
saved mandate token *and* the Recurring Payments feature switched on by Razorpay
Support — not available to a hackathon account.

**Why it mattered:** the verb the entire product was built around was
unavailable. Discovered before writing code, which is the only reason it was
cheap.

**Fix:** the action vocabulary was rebuilt around what actually exists — issue a
new payment link, re-notify via `notify_by`, cancel, escalate. The word "retry"
was banned from the product entirely, and the agent's job shifted from
*scheduling retries* to *choosing whether, when and whom to contact*. That turned
out to be the harder and more interesting problem.

**Cost:** ~2h of research. **Value:** avoided building a product around a
non-existent API.

---

## 2. Our own thesis failed its own evaluation

**Day 3. The most important one.**

The differentiator was uplift: contact only the customers who would *not* have
paid anyway. The evaluation harness and all baselines were deliberately built
**before** the model, so the idea could be falsified early.

It was. On the held-out set:

| policy | net incremental | % of oracle |
|---|---|---|
| contact everything | Rs 1,111,202 | **98.3%** |
| perfect oracle | Rs 1,129,941 | 100% |

**A naive "chase everything" baseline captured 98.3% of what a perfect oracle
could achieve.** A flawless uplift model would have beaten it by 1.7%. The
differentiator was worth almost nothing.

The cause was arithmetic, not a bug: mean uplift x mean amount is ~Rs 1,131 per
contact against a contact cost of ~Rs 150, so contacting is positive-EV for 83%
of items. When chasing is nearly free and tickets are large, chasing everyone
genuinely *is* close to optimal — in the model and in reality.

**Fix:** rather than tune the world until we won, we asked where the assumption
breaks. Merchants cannot contact everyone — DND windows, SMS budgets and agent
capacity all bind. Re-framed as **selection under a contact budget**, which is
also closer to Track 03's own words ("bounded recovery workflow", "stopping
rules"). Under a budget of 300 contacts, ranking by uplift x value beats:

- chasing the biggest tickets by **+29.3%**
- chasing whoever is most likely to pay by **+66.4%**

All three differences significant under a *paired* bootstrap.

**What made it findable:** building the evaluation before the model. Had this
surfaced on Day 7 with a dashboard already built around the original claim, the
demo would have collapsed under the first question a judge asked.

---

## 3. A naive classifier is not just worse — it is actively wrong

**Day 3, follow-on from the above.**

Widening to all three risk classes exposed *why* uplift beats probability, in a
way one class never could. Where each ranker spends a 300-contact budget:

| ranker | abandoned | failed pmt | receivables |
|---|---|---|---|
| by recovery probability | 10 | 92 | **198** |
| by ticket size | 34 | 121 | **145** |
| **by uplift x value** | **83** | 121 | 96 |

Receivables carry the largest tickets (Rs 33,666 mean) but **self-pay 62% of the
time**. A classifier trained to predict "who will pay" pours two-thirds of the
budget into invoices that were going to be paid anyway.

**Fix:** none needed — this is the evidence, not the problem. Worth logging
because it only became visible after widening scope, and it is the single most
legible artefact in the project.

---

## 4. Our own calibration metric was lying

**Day 4.**

First training run reported ECE of **0.0000** — perfect calibration. It was
fitting isotonic regression on the validation set and then measuring calibration
error on those same rows. The calibrator was interpolating its own training data,
so a perfect score was guaranteed regardless of model quality.

Calibration is the property the whole EV formula depends on, because expected
value multiplies a probability by rupees. A miscalibrated model produces
confidently wrong money decisions.

**Fix:** fit the calibrator on one half of validation, measure ECE on the other.
Honest numbers: 0.058 -> 0.033 (control arm), 0.050 -> 0.057 (contact arm).

**Then a second problem appeared:** with the honest measurement, isotonic made
the control arm *worse*. At ~250 rows per arm it overfits. Switched to Platt
scaling — a two-parameter sigmoid, the standard choice at that sample size —
chosen a priori rather than after seeing which won. It also improved
predicted-vs-true uplift correlation from **0.554 to 0.673**.

---

## 5. A missing `https://` took down payment ingestion

**Day 2, production.**

Every webhook returned a blank 500. Ruled out in sequence: Vercel Deployment
Protection (real, and fixed first — it was intercepting requests with a 401
before our handler ran); then a suspected missing `DATABASE_URL`; then a
suspected broken Git integration.

None of those. The actual cause: `APP_URL` had been set in Vercel without a
protocol. Our Zod schema demanded `z.string().url()`, so parsing threw at the top
of the request handler, before any logic ran, and Next.js surfaced it as an empty
500 with no detail.

**Fix, in two parts.** First, built `/api/health` to report which variables are
present (booleans only, never values) and whether the database answers — turning
an opaque 500 into a named cause. Then fixed the root: `APP_URL` now accepts a
bare host and normalises it, because a missing protocol should never be able to
break payment ingestion.

**Lesson worth telling:** the debugging chain was three wrong hypotheses deep
before the health endpoint made the answer obvious in one request. The fix was
building an instrument, not guessing harder.

---

## 6. Supabase's direct host is IPv6-only

**Day 1.**

The connection string from the dashboard failed with `ENOTFOUND`. DNS showed
`db.<ref>.supabase.co` resolving to an AAAA record only — no IPv4 — and the
build network has no IPv6 route.

Two further wrinkles: the password contained `@`, which breaks URL parsing unless
percent-encoded to `%40`; and the pooler uses a different username format
(`postgres.<project-ref>`, not `postgres`).

**Fix:** switched to the connection pooler, which is dual-stack. The region
wasn't known, so rather than sending the user back to the dashboard, we swept
candidate pooler hostnames programmatically and found it (`ap-southeast-1`, not
the `ap-south-1` the IPv6 prefix suggested). Documented in the README so the
Vercel deployment didn't repeat it.

---

## 7. Both LLM model IDs were dead before we used them

**Day 2.**

The planned chain was `gemini-2.5-flash` with `llama-3.3-70b-versatile` as
fallback. Verifying against provider docs before writing the integration:

- Google returns *"models/gemini-2.5-flash is no longer available to new users"*
- `llama-3.3-70b-versatile` is no longer in Groq's production catalogue

**Fix:** pinned to `gemini-3.7-flash` and `openai/gpt-oss-120b`, and wrote
`scripts/check-providers.ts` — a live health check for the whole fallback chain,
because a chain pointing at a decommissioned model fails silently until the
moment it is needed.

**Related:** the first live call then failed with *"response did not match
schema"*. Isolating it took several attempts (`tsx -e` turned out to be a silent
no-op; top-level await doesn't compile under the CJS target). The real cause:
**Gemini does not honour `maxLength` in structured output** — a `z.string().max(160)`
made it emit a longer string, and Zod rejected the whole response. Reproduced
twice, then fixed by removing length caps from LLM schemas and truncating after
parsing. That bug would only fire when the model happened to be verbose, which
makes it exactly the kind of intermittent failure that surfaces during a demo.

---

## 8. Committed a documentation file that was silently empty

**Day 2.**

`create-next-app` (Next.js 16) writes its own `CLAUDE.md` containing a pointer to
`AGENTS.md`, which overwrote a 340-line decisions document moments after it was
written and before any commit. It was then used to generate `DECISIONS.md`, which
was committed as an 11-byte stub — and nobody noticed, because the generation
script reported success.

Compounding it: the git index held stale pre-edit content, so several commits
captured old versions of files that had since been changed.

**Fix:** audited every historical tree rather than just the working copy, found
both problems, and rebuilt the history before anything was pushed. Now the
verification step for any generated file checks size and structure, not just the
exit code.

**Lesson:** "the script said it worked" is not verification.

---

## 9. Simulated actions were calling the live API

**Day 5.**

The executor supports LIVE and SIM modes, because Test Mode caps payment links
so part of any batch must be simulated. Before executing anything it re-reads
the entity from Razorpay — a customer who paid thirty seconds ago must not get
chased.

The executor safety tests came back 12 passed, 5 failed, with every failure the
same: `aborted_settled`. The guard was doing its job — synthetic test entities do
not exist in Razorpay, `fetchPayment` threw, and the guard fails closed. But that
exposed the real defect: **SIM mode was making live Razorpay calls** to perform
its state check. A simulation that touches the network is not a simulation, and
on demo day it would have burned API calls and latency for actions that were
never real.

**Fix:** the check now reads our own normalised store first — free, and catches
most cases — and only LIVE additionally confirms against Razorpay, because our
copy can lag a webhook by exactly the seconds in which someone pays. SIM stops at
the local check.

The tempting fix was to loosen the guard so the tests passed. That would have
removed the property the guard exists for. 17/17 after fixing the actual bug.

**Lesson:** a test failing for the "wrong" reason is often pointing at something
real. The failure mode was correct; the thing it revealed was not.

---

## 10. Making the LLM load-bearing without making it the authority

**Day 6.**

By the end of Day 5 the system worked and had no LLM in it at all. The
deterministic core — detection, scoring, expected value, policy, execution — was
built and tested, but `lib/llm.ts` did not exist. For a track called *AI Revenue
Recovery* asking for an *agent*, the honest answer to "where is the AI?" was "a
logistic regression sorts a queue."

The temptation was to bolt on a narrative generator: have the model write prose
about each failure. That is decoration. The system would be identical without it.

**What we built instead — payment degradation to root cause, in three stages:**

1. **Deterministic.** Cluster open failures by (method, bank, error_reason),
   compute each cluster's rate against its own trailing 7-day baseline, pull live
   Razorpay downtime records.
2. **LLM.** Given that evidence, hypothesise a root cause and a disposition for
   the whole cluster.
3. **Deterministic.** Corroborate. `DEFER_UNTIL_RESOLVED` is only honoured when a
   live downtime record exists, or the rate exceeds 3x baseline *and* the failures
   are concentrated within 3 hours. Otherwise the hypothesis is downgraded and
   the override is recorded.

This makes the model genuinely load-bearing — it can stop an entire cluster of
contacts from going out — while never being the authority. An uncorroborated
claim changes nothing except an audit row saying we disagreed.

**It fired on the first real run, unscripted.** Seeded with an HDFC netbanking
outage and an unrelated AXIS decline pattern, the model correctly identified the
outage and deferred it — and also recommended deferring the AXIS cluster.
Corroboration overrode that: no downtime reported, and 276 minutes is not a
spike. The override text is now a demo beat, because it is the safety model
demonstrating itself rather than being described.

**A bug this exposed:** the baseline included the analysis window in its own
denominator, so a current spike inflated the number it was being compared
against and every cluster looked anomalous at 28x. Fixed by excluding the window
from its own baseline.

**Lesson:** "use an LLM meaningfully" does not mean give it more authority. It
means give it a job only it can do — synthesising a cause from heterogeneous
evidence — and then make it prove its answer against something it cannot fake.

---

## 11. A STOP decision sent a real payment link

**Day 6, first live batch. The worst bug in the project.**

After the webhook captured two genuine failed payments, the first fully live
batch ran. It reported success — two real Razorpay payment links created, two
notifications sent. Then the audit rows showed what had actually happened:

```
STOP [LIVE] succeeded | EV Rs1960
   razorpay id : plink_TSxgyFc4Dg7l1j
   PAY HERE    : https://rzp.io/rzp/B4x9ZAs
```

**The decided action was `STOP`, and it created a payment link and messaged a
customer.** The single promise this product makes is that a blocked action does
not happen. It happened.

Two independent defects lined up:

1. **`expectedValue` credited every action with the full uplift.** Uplift is the
   incremental effect *of contacting*; do-nothing realises none of it. But the
   formula computed `uplift x amount` regardless of action, so `STOP` scored the
   full gross at zero cost and therefore outranked every real action. The agent
   was proposing to do nothing for every item — while scoring that as the best
   possible choice.

2. **The executor had no gate on which actions may reach Razorpay.** Its live
   path handled `CHASE_INVOICE` and `WITHDRAW` explicitly and let everything else
   fall through to "create a payment link". So the incoherent `STOP` proposal was
   faithfully executed as an outward action.

**Fix:** gross is now zero for any action that does not reach the customer, and
`EXECUTABLE_ACTIONS` is a hard gate — `STOP`, `DEFER` and `ESCALATE_HUMAN` throw
if they ever reach the executor, in both live and simulated paths. Four
regression tests lock both, including one asserting a decision can never contact
anyone.

**Why it survived until then:** every earlier test supplied the action
explicitly. Nothing had ever exercised *ranking choosing the action* end to end.
The unit tests were green, the executor safety suite was 17/17, and the bug sat
directly between them.

**The cleanup mattered too.** Two real payment links existed against a decision
that said STOP, so they were cancelled and the corrupted decision rows deleted
rather than left to flatter the numbers.

**Lesson:** integration bugs live in the seams between well-tested components.
Running the real thing once found what 52 passing tests could not.

---

## 12. Razorpay's duplicate-`reference_id` guard is weaker than documented

Found by running the first live batch after the #11 cleanup, not by a test.

`DECISIONS.md` §3 records `reference_id` as rejecting duplicates with an error —
the behaviour our executor leans on when it adopts an existing link instead of
minting a second one. Today's live run created:

```
plink_TT81QYGeIUDJpn  created    reference_id dlt_846a7c31c9db4099bc6bc7bd8fa6_1
plink_TSxguZD3WTCF6E  cancelled  reference_id dlt_846a7c31c9db4099bc6bc7bd8fa6_1
```

**Two live payment links, same `reference_id`, no error.** The second was created
cleanly and never hit the duplicate-reference branch.

The difference between them is that the older link had been **cancelled** during
the #11 cleanup. The inference — that cancelling a link releases its
`reference_id` for reuse — fits the evidence but has not been isolated; proving
it means attempting a create against an *active* link's reference, which costs a
link from the test-mode budget if it succeeds. Recorded as observed behaviour,
not as a confirmed mechanism.

**Why it does not compromise the safety argument:** provider-side reference
uniqueness was always the outer of two guards. The inner one is ours —
`action_attempts.idempotency_key` UNIQUE, written *before* the outbound call
(§8) — and it is unconditional. It held here: this run wrote exactly one attempt
row per item. The duplicate link was possible only because the #11 cleanup
deleted the decision rows, wiping our ledger while Razorpay's links survived it.

**Lesson:** a guard you do not own can be conditional in ways the documentation
does not state. The reason this was a note in a log rather than a double-charged
customer is that the guard we *do* own sits underneath it and does not depend on
the provider behaving as described.

---

## 13. Reconciliation had never actually worked

Found by running it, on day 7, for the first time from a terminal.

Reconciliation is one of two detection paths and a stated safety mechanism:
Razorpay does not fire `payment.failed` for every failure, and there is no
abandonment event at all, so the sweep is what catches everything webhooks miss.
It had been deployed since day 1 and called by Vercel Cron daily. It had three
bugs and had never once opened an abandoned checkout in production.

**1. `expand[]=payments` does not return an array.** It returns a Razorpay
collection — `{ entity: "collection", count, items: [...] }`. `lib/razorpay.ts`
typed it as `RzpPayment[]` and the route did `for (const p of o.payments ?? [])`,
which throws `object is not iterable` on any order that has payments. The type
was a guess that TypeScript then faithfully protected.

**2. A JS `Date` interpolated into a `sql` template.** The abandonment sweep
compared `createdAtRzp < cutoff` inside `sql```, which binds the Date unmapped;
postgres-js then throws `The "string" argument must be of type string ...
Received an instance of Date`. Using drizzle's `lt()` applies the column's
timestamp mapper. The two bugs sat about fifteen lines apart, so the first
masked the second.

**3. It re-opened cases that were already settled.** `orderAlreadyPaid` joined
through `payments.order_id`, which is null whenever a payment was ingested
before its order — the normal case for `payment.failed`. So the guard answered
"no", and the sweep re-opened a risk item for a payment whose money had already
arrived. That is precisely the "chase money that already arrived" behaviour the
product promises not to do, and it was live.

The partial unique index did not catch it either, correctly: it forbids two
*open* items for one entity, which is the right constraint for the two detection
paths racing. Nothing forbade re-opening something closed as recovered. Openers
now refuse an entity that already has a `recovered` or `closed` item.

**Why the suite missed all three.** `verify-ingestion.ts` was 24/24 green
throughout, including a check named "abandonment closed". It exercises the
*opener* — `openRiskForAbandonedCheckout` — directly, with rows placed in the
database by the test. Nothing exercised the *sweep* that finds candidates and
calls the opener, and nothing fetched a real order from Razorpay with payments
expanded. The tested unit was fine; the path around it had never run.

**Lesson:** a scheduled job that reports success is not evidence it did
anything. This one returned HTTP 200 every night — the counts it returned were
zeros, and nobody had asked why a zero was plausible.

---

## Which to use in the writeup

**Strongest: #2 — the thesis failing its own evaluation.** It is the most
honest and the most technically credible: we built the falsification test before
the thing being tested, ran it, watched our differentiator evaporate, and then
found the regime where it genuinely holds instead of quietly tuning the world
until we won. It demonstrates scientific discipline rather than cleverness, and
#3 provides a vivid visual payoff.

**Runner-up: #1** — researching the API before building and discovering the core
verb did not exist, then reshaping the product around what was actually
supported. Good for showing judgement under constraint.

**Best "engineering war story": #11** — a STOP that sent a payment link, caught
by running the real thing once, with the two-defect root cause and the cleanup.
Runner-up #5 — three wrong hypotheses, then building an
instrument instead of guessing harder.
