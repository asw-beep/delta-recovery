# Delta

**Revenue recovery that only chases the money that wouldn't come back on its own.**

Razorpay Buildathon 2026 — Track 03, AI Revenue Recovery.

Live: **https://delta-recovery-aswin-s-projects-c3bce5f6.vercel.app**

---

## The problem with recovery tools

Most failed payments recover by themselves. The customer taps again, the bank
comes back up, the card gets topped up. A tool that messages everyone who failed
is spending money and customer patience to buy revenue that was already on its
way.

On our held-out test set, **28.1% of a contact-everything strategy is wasted** —
534 of 1,900 messages reach someone who was going to pay regardless. For overdue
receivables it is worse: **62% of them pay with no contact at all**, so only
about ten percentage points of that revenue is purchasable.

Ranking by "most likely to pay" is the more sophisticated-sounding version of
the same mistake. A customer with a 90% chance of paying is a *bad* target
precisely because they are going to pay.

## What Delta optimises instead

Not the probability that someone pays — the difference contacting them makes.

```
uplift(a|x) = P(pay | x, action a) − P(pay | x, do nothing)
EV(a|x)     = uplift(a|x) · amount − cost(a) − λ · fatigue(x, a)
policy(x)   = argmax EV over permitted actions
              do-nothing is always in the set, at EV 0
```

Three consequences, and all three are load-bearing:

- **Doing nothing is a real option**, sitting in the ranking at exactly zero. An
  action scoring below it loses, so the agent declines rather than acting for
  the sake of acting.
- **Goodwill is priced.** An SMS costs ₹0.20 to send and one unit of customer
  patience, valued at ₹150. That is what stops the agent messaging everybody.
- **A big invoice is not automatically worth chasing.** Uplift multiplies the
  amount, so ₹40,000 at 2% uplift is worth less to pursue than ₹9,000 at 31%.

## Results

Held-out test split, opened once. Every strategy gets the same budget of 300
contacts and is scored on *net incremental* revenue — earned above doing
nothing, minus spend.

| Strategy | Net incremental | 95% CI |
|---|---:|---|
| **Delta — uplift × value** | **₹11.47L** | ₹8.38L – ₹15.02L |
| Dunning ladder (day 0/3/7) | ₹9.43L | — |
| By ticket size | ₹8.87L | ₹5.91L – ₹12.27L |
| By recovery probability | ₹6.89L | ₹4.23L – ₹9.70L |
| Random | ₹3.10L | — |

**+29.3%** over ranking by ticket size · **+66.4%** over ranking by recovery
probability. Bootstrap paired differences exclude zero against every baseline.

Numbers are read from [`eval/results.json`](eval/results.json), produced by a
committed run at seed `20260823` over 1,900 items. Nothing in the UI or in this
file is typed by hand.

### On live money

The system has recovered **₹16,998** of real money on a live Razorpay test
account, across two independently attributed outcomes:

```
decision f1e2cddf  →  payment link carrying notes.decision_id
                   →  payment_link.paid   (HMAC-verified webhook TVa3QDZCnmp1SW)
                   →  outcome: recovered, ₹8,499
                   →  risk item closed: recovered_after_intervention
```

The second of the two ran the entire loop in one sitting: a real card failure
fired `payment.failed`, the webhook path opened a risk item **four seconds
later**, it ranked first in the batch at an expected value of ₹1,918 — ahead of
an ₹18,750 invoice, which is the thesis visible in the ordering — and the agent
minted the link that was then paid.

Reproduce the whole chain against the database in one command:

```bash
npx tsx scripts/verify-attribution.ts
```

### It declines credit it did not earn

This matters more than the figure above, and there are two distinct ways it says
no.

**Money that arrives with no contact at all.** ₹32,490 landed on a link the agent
had never messaged anyone about; those items closed
`self_recovered_without_intervention` and contributed nothing.

**Money that arrives after we acted, but not because we did.** The agent had
nudged a customer who then paid an entirely different link. "We acted" is not
"we caused it", so that item closes `settled_unattributed` — real recovered
money in the world, no claim on it by Delta. Only
[`attributeRecovery`](lib/batch.ts) may record a recovery, because it is the
only path holding proof: a decision id carried out on the link and returned by
an HMAC-verified webhook.

## How it works

```
Razorpay webhook ─┐
                  ├─→ normalise → detect risk → diagnose
reconciliation ───┘                    │
══════════════ no language model below this line ══════════════
                    score uplift → rank by EV → policy → execute
                                        │            │
                            ALLOW / DELAY /      idempotent,
                          ESCALATE / STOP        budget-bounded
                                                      │
                              verify via webhook → attribute → outcome
```

The model reads failures and writes explanations. It selects from a fixed enum
and produces prose; it never computes a number and never authorises a payment.
Scoring, expected value, policy evaluation, idempotency and execution are
deterministic TypeScript with unit tests — so *"what if it hallucinates?"* has a
code-path answer rather than a reassurance. If the model is unavailable the loop
runs unchanged on template strings.

### Deliberate refusals

| It will not | Because |
|---|---|
| Claim credit it did not earn | Money arriving with no contact is recorded as self-recovery |
| Present a simulation as real | Test Mode caps payment links; SIM rows are labelled and the banner is not dismissible |
| Let the model act | Every rupee, probability, verdict and API call is deterministic code |
| Message into an outage | An open downtime defers the whole affected cluster |
| Re-present a failed charge | No such API exists — see below |

### Stopping rules and compliant escalation

Evaluated after scoring and before execution, as a pure function with one unit
test per rule.

| Rule | Default | Verdict |
|---|---|---|
| Customer opted out | — | `STOP` |
| Item already paid (re-read from Razorpay first) | — | `STOP` |
| `payment_risk_check_failed` | — | `ESCALATE`, never automated |
| Amount above high-value threshold | ₹25,000 | `ESCALATE` |
| Contacts to this customer, trailing 7 days | max 3 | `STOP` |
| Actions on this pursuit | max 2 | `STOP` |
| Age since detection | 72h | `STOP` |
| Quiet hours IST | 21:00–09:00 | `DELAY` |
| Open downtime for the instrument | — | `DELAY` |
| Net EV below floor | ₹5 | `STOP` |
| Uplift below floor | 0.03 | `STOP` — would likely recover anyway |
| Scorer unavailable or low confidence | — | `ESCALATE` |

A blocked action writes a decision row exactly like a sent one, so a `STOP` is
as auditable as a send.

## The constraint everything is built around

**There is no Razorpay API that retries a failed payment.** The Payments API is
capture, fetch and update; `failed` is terminal. We verified this before
building, and it reshaped the product: recovery cannot mean re-presenting the
card, only issuing a new payment link and deciding whether to mention it.

Which is the point. The action is a commodity — anyone can create a payment
link. The judgement about *whether it is worth sending* is the product.

Other verified constraints, with the workarounds they forced, are in
[DECISIONS.md §3](DECISIONS.md).

## Why this is not what Razorpay already ships

Razorpay already offers Failed Payment Recovery, Intelligent Payment Retry and
Agent Studio's Subscription Recovery and Abandoned Cart agents. Delta does not
compete on the action — it uses the same payment links and the same nudges.

It competes on the **decision layer**: which of these customers is worth
contacting at all, priced in incremental rupees, with the arithmetic on screen
and a do-nothing floor it has to beat.

## What this does not prove

- **The test set is ours.** Items come from `eval/generate.py`, not production
  traffic. The do-nothing floor and oracle ceiling are deliberately
  self-punishing and the generator is committed, but a world you built is still
  a world you chose. The live recovery is real; the margin is a simulation until
  it meets a merchant's own data.
- **Rankers in the evaluation use true uplift.** The comparison is between
  *allocation strategies* given a correct score. A miscalibrated model would
  degrade Delta specifically, because it multiplies probability by rupees.
- **Compliance costs revenue here, and is counted against us.** 35 items worth
  ₹2.83L were blocked by quiet hours, fatigue caps and risk rules; that loss
  sits in Delta's own score rather than being quietly excluded.

## Stack

Next.js 16 (App Router) · TypeScript · Postgres (Supabase) · Drizzle with real
migrations · Tailwind + shadcn/ui · TanStack Table · Recharts · Razorpay Node
SDK · Vercel AI SDK (Groq primary, Gemini fallback) · Resend · scikit-learn,
offline only — training emits `model.json`, scoring is ~40 lines of TypeScript,
and no Python ever deploys.

Dashboard colours are transcribed from Razorpay's own design system, Blade.
Chart palettes are validated for colourblind separation and contrast rather
than chosen by eye.

## Running locally

```bash
npm install
cp .env.example .env      # Razorpay test keys, DATABASE_URL, GROQ_API_KEY
npm run db:migrate
npm run dev
```

Webhooks need a public URL — tunnel with `cloudflared` or `ngrok` and register
the endpoint in the Razorpay dashboard under Test Mode.

> **Supabase note:** use the **connection pooler** string, not the direct one.
> `db.<ref>.supabase.co` resolves to IPv6 only, so it fails on IPv4-only
> networks. The pooler host (`aws-0-<region>.pooler.supabase.com`) is
> dual-stack, and its username is `postgres.<project-ref>`. Percent-encode any
> `@` in the password as `%40`.

### Verifying it

```bash
npx vitest run                          # 35 unit tests: uplift, EV, policy
npx tsx scripts/verify-ingestion.ts     # detection and reconciliation, live DB
npx tsx scripts/verify-executor.ts      # idempotency under concurrency
npx tsx scripts/verify-attribution.ts   # recovered money traced to its decision
npx tsx scripts/verify-degradation.ts   # cluster analysis with the live model
npx tsx scripts/check-providers.ts      # LLM chain health
```

### Running a recovery batch

```bash
npx tsx scripts/run-batch.ts --dry --budget 50      # decide, execute nothing
npx tsx scripts/run-batch.ts --budget 50 --live 2   # 2 real links, rest simulated
```

`--live` bounds how many real Razorpay calls a run may make. Test Mode caps
payment links per business, so the remainder execute as simulations and are
labelled `SIM` everywhere they appear.

## Documentation

- [DECISIONS.md](DECISIONS.md) — locked architecture and the verified Razorpay
  constraints it is built around
- [docs/status.md](docs/status.md) — current state; start here to resume
- [docs/difficulties.md](docs/difficulties.md) — what broke during the build,
  how it was found, and what fixed it
