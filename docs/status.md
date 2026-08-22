# Status — start here

Last updated: **23 Aug 2026, ~03:00 IST**, end of Day 6 work.

Read this first when resuming. `DECISIONS.md` has the locked architecture;
`docs/difficulties.md` has the submission writeup material.

---

## Where we are

**Ahead of schedule.** Two calendar days elapsed, roughly six days of the
seven-day plan done, plus a scope widening and the LLM layer.

| Day | Planned | State |
|---|---|---|
| 1 | Scaffold, schema, webhook receiver, deploy | done, verified in production |
| 2 | Ingestion, detection, reconciliation | done, 24/24 against live DB |
| 3 | Generator, harness, baselines | done, plus the budget reframe |
| 4 | EV, policy engine, uplift model | done, 35 unit tests |
| 5 | Executor, idempotency, attribution | done, 17/17 |
| 6 | LLM degradation analyst | done, 8/8 · **dashboard NOT started** |
| 7 | Drills, freeze, README, rehearsal | not started |

**Verification suites** (all against the live database):

```
npx vitest run                        35 unit tests
npx tsx scripts/verify-ingestion.ts   24 checks, 3 risk classes
npx tsx scripts/verify-executor.ts    17 checks, incl. 10 concurrent executions
npx tsx scripts/verify-degradation.ts  8 checks, live LLM
npx tsx scripts/check-providers.ts    Groq + Gemini health
npx tsx scripts/probe-account.ts      what the Razorpay account can do
```

---

## Do this first tomorrow

**1. Run the live batch after 09:00 IST.**

Two real failed payments are sitting as open risk items. The agent proposes
`NUDGE_EMAIL` on both (EV Rs 1,810 and Rs 2,212) but the policy engine returns
`DELAY` because of quiet hours. That is correct behaviour, not a blocker — it
simply cannot execute until 9am.

```bash
npx tsx scripts/run-batch.ts --dry --budget 50      # confirm ALLOW, not DELAY
npx tsx scripts/run-batch.ts --budget 50 --live 2   # real links + real email
```

Then **pay one of the resulting links** to produce the first genuinely recovered
revenue and exercise attribution (`notes.decision_id` → `payment_link.paid` →
outcome row → risk item closed as `recovered_after_intervention`).

That closes the last unmet item on Track 03's bar: *measured money recovered*.

**2. Then build the dashboard** — the whole system is currently invisible.
Overview with the self-recovery split, queue, decision drilldown, evaluation page.

---

## Live facts

| | |
|---|---|
| Repo | `asw-beep/delta-recovery` (private) |
| Deployment | `https://delta-recovery-aswin-s-projects-c3bce5f6.vercel.app` |
| Health | `GET /api/health` → `{"ok":true}` |
| Webhook | registered and **confirmed delivering** real events |
| Database | Supabase pooler, `ap-southeast-1`, 15 tables + 2 migrations applied |
| Payment links | **3 of ~30 used**, 27 left — reserve 15 for demo day |
| Test link (unpaid) | `https://rzp.io/rzp/sWt681GI` |

**Real data currently in the database:** 2 payments, 2 open risk items
(Rs 8,499 each), 2 webhook events, 2 customers. Everything else is empty —
decisions were deliberately cleared after the STOP bug (below).

---

## Open items

- [ ] Live batch after 9am IST, then pay a link → first real recovered revenue
- [ ] Dashboard (Day 6 remainder) — nothing is visible yet
- [ ] Day 7: failure drills, freeze, final eval run, README, demo rehearsal,
      backup recording
- [ ] Re-run `check-providers.ts` before demo day; model IDs move
- [ ] Vercel cron is daily (`0 3 * * *`) because Hobby restricts it; the demo
      triggers reconciliation manually

---

## Things not to relearn

These cost real time to discover. All are recorded in `docs/difficulties.md`.

- **No Razorpay API retries a failed payment.** The word "retry" is banned from
  the product. Recovery means a new payment link.
- **Supabase direct host is IPv6-only** — must use the pooler, username
  `postgres.<ref>`, password `@` encoded as `%40`.
- **Gemini ignores `maxLength`** in structured output. Never put `.max()` on a
  string in an LLM schema; truncate after parsing.
- **`create-next-app` overwrites `CLAUDE.md`** with a pointer to `AGENTS.md`.
  Both are gitignored via `.git/info/exclude`, not `.gitignore`.
- **Environment variables do not trigger a Vercel rebuild.** Redeploy after
  changing them.
- **Vercel Deployment Protection blocks webhooks** with a 401 before the handler
  runs. Must be off for production.

---

## The one open judgement call

The headline evaluation numbers (+29.3% over ticket-size ranking, +66.4% over
recovery-probability ranking) come from our own generator. The oracle ceiling and
the deliberately self-punishing structure blunt the "you built the world you
beat" objection, but do not remove it. Publish the generating process
prominently in the README, and show where the agent loses.

---

## Recommended difficulty for the submission writeup

**#11 — a STOP decision that sent a real payment link.** Two defects lined up:
expected value credited do-nothing with the full uplift so `STOP` outranked every
real action, and the executor had no gate on which actions may reach Razorpay. It
survived 52 passing tests because every test supplied the action explicitly —
nothing had exercised *ranking choosing the action* end to end. Running the real
thing once found it.

Runner-up: **#2**, the thesis failing its own evaluation on Day 3.
