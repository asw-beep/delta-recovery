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

**Best "engineering war story": #5** — three wrong hypotheses, then building an
instrument instead of guessing harder.
