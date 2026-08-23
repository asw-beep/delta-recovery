# Status — start here

Last updated: **23 Aug 2026, ~23:35 IST**. Paused mid-Day-7.

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

**1. After 09:00 IST — run a live batch.** Quiet hours (21:00–09:00) currently
turns every otherwise-allowable item into `DELAY`, which is correct but means
`ALLOW` and live execution are unreachable at night.

```bash
npx tsx scripts/run-batch.ts --dry --budget 50      # confirm ALLOW appears
npx tsx scripts/run-batch.ts --budget 50 --live 2   # real links + SIM remainder
```

Then pay one link to produce a **second** attributed recovery, so the demo shows
recovery across a batch rather than the single case from 23 Aug.

**2. Fix batch performance.** A batch is **136 seconds** over 107 items. The
demo gate is three clean runs under 4:30, so one command is eating half the
budget — and it grew from 130s as items were added, so it scales with volume.
Suspects, in order: per-item LLM calls that should hit the class-level cache,
and N+1 queries building the policy context (`optedOut`, `contactsInWindow`,
`actionsOnItem`, `downtimeOpenFor` all run per item).

**3. Then Day 7 proper** — failure drills (LLM down, Razorpay down, database
down, kill mid-batch), final eval run and freeze, README pass, rehearsal,
backup recording.

---

## Live facts

| | |
|---|---|
| Repo | `asw-beep/delta-recovery` (private) |
| Deployment | `https://delta-recovery-aswin-s-projects-c3bce5f6.vercel.app` |
| Routes | `/` `/queue` `/escalations` `/evaluation` `/decisions/[id]` `/api/health` — all 200 |
| Database | Supabase pooler, `ap-southeast-1`, 15 tables + 4 migrations |
| Payment links | **6 of ~30 used**, ~24 left — reserve 15 for demo day |
| Recovered | **₹8,499**, attributed, 23 Aug |

**Database contents:**

```
risk_items    112   107 open · 1 in_progress · 4 recovered · 97 synthetic
  failed_payment      70   of which real: 6
  abandoned_checkout  33   of which real: 9
  overdue_receivable   9   of which real: 0
decisions     DELAY 228 · ESCALATE 41 · STOP 38 · ALLOW 7
escalations   14 open · 1 resolved
outcomes      1 recovered, ₹8,499
attempts      1 live · 1 sim
```

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

**The dashboard is 97 synthetic to 15 real.** All labelled, so it is honest, but
the overview reads as a synthetic product with a real footnote rather than the
reverse. Decide deliberately before demo day: purge and reload something
smaller, or default the queue to live-only.

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
