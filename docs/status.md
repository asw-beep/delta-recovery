# Status — start here

Last updated: **23 Aug 2026, ~14:15 IST**, after the first live recovery.

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
| — | Live batch, real recovery, attribution proved | done, 10/10 |
| 7 | Drills, freeze, README, rehearsal | not started |

**Verification suites** (all against the live database):

```
npx vitest run                        35 unit tests
npx tsx scripts/verify-ingestion.ts   24 checks, 3 risk classes
npx tsx scripts/verify-executor.ts    17 checks, incl. 10 concurrent executions
npx tsx scripts/verify-degradation.ts  8 checks, live LLM
npx tsx scripts/verify-attribution.ts 10 checks, real recovered money
npx tsx scripts/check-providers.ts    Groq + Gemini health
npx tsx scripts/probe-account.ts      what the Razorpay account can do
```

---

## Do this first

**The dashboard.** It is the only substantial thing left, and the whole system
is still invisible — overview with the self-recovery split, queue, decision
drilldown, evaluation page. Everything it needs to render now exists as real
rows, including one genuine recovery.

Then Day 7: failure drills, freeze, final eval run, README, rehearsal.

---

## Money recovered — the bar is met

Rs 8,499, measured, on 23 Aug. `npx tsx scripts/verify-attribution.ts` re-proves
the whole chain against the live database in one command:

```
decision 97445e99  ->  plink_TT81QYGeIUDJpn carrying notes.decision_id
                   ->  payment_link.paid  (event TT9GTT2AxunVx9, HMAC valid)
                   ->  outcome: recovered, Rs 8,499
                   ->  risk item closed: recovered_after_intervention
```

The recovered amount equals the amount at risk, and the proof is a
signature-verified webhook Razorpay sent — not something we wrote ourselves.

**The best demo moment came from a failure.** Paying the link first failed on an
international test card, which opened a *third* risk item against our own
recovery link. When the link was then paid properly, that child item closed as
`self_recovered_without_intervention` while the parent closed as
`recovered_after_intervention`. The system watched money arrive and **declined
to claim credit for it**. That is the thesis surviving contact with a real
event, and it is worth showing.

---

## Known: the recovery loop

A failed payment *on our own recovery link* opens a fresh risk item. Because it
is a new item with zero prior actions, the "max 2 actions on this risk item" cap
does not bind — only the per-customer fatigue cap (3 contacts / 7 days) stops an
unbounded link -> fail -> link cycle.

It did not bite here (the child self-closed when the link was paid), and a fresh
link for `INSTRUMENT_DEAD` is the *right* action since a payment link is not
bound to the dead card. Unresolved by choice, not by oversight. Options:

1. Link child items to their parent so action counts carry along the chain —
   keeps the item-level cap meaningful. **Recommended.**
2. Suppress detection when a failed payment's `notes.decision_id` is one of ours
   — simpler, but hides genuine repeat risk.
3. Leave it, and document the fatigue cap as the backstop.

---

## Live facts

| | |
|---|---|
| Repo | `asw-beep/delta-recovery` (private) |
| Deployment | `https://delta-recovery-aswin-s-projects-c3bce5f6.vercel.app` |
| Health | `GET /api/health` → `{"ok":true}` |
| Webhook | registered and **confirmed delivering** real events |
| Database | Supabase pooler, `ap-southeast-1`, 15 tables + 2 migrations applied |
| Payment links | **4 of ~30 used**, 26 left — reserve 15 for demo day |
| Test link (unpaid) | `https://rzp.io/rzp/sWt681GI` |
| Recovered | **Rs 8,499**, attributed, 23 Aug |

**Real data currently in the database:** 3 payments, 3 risk items (2 recovered,
1 in_progress), 9 webhook events, 2 customers, and one full
decision -> attempt -> outcome chain. The `in_progress` item is the SIM contact
from the live batch — no real link exists for it, so nothing will ever pay it.
That is correct, not a stuck row.

**Test cards that matter** (`4111 1111 1111 1111` is *international* and this
account is domestic-only — it fails with `international_transaction_not_allowed`):

| Purpose | Card |
|---|---|
| Domestic success | `4100 2800 0000 1007` |
| `payment_timed_out` | `4100 2800 0009 0000` |
| `insufficient_fund` | `4100 2800 0008 0001` |
| `payment_cancelled` | `4100 2800 0007 0002` |
| `card_declined` | `4100 2800 0006 0003` |
| `card_disabled_for_online_payments` | `4100 2800 0003 0006` |
| `gateway_technical_error` | `4100 2800 0002 0007` |
| `authentication_failed` | `4100 2800 0000 0009` |

Random CVV, any future expiry. OTP of 4–10 digits succeeds, under 4 fails; for
the error cards, pick **failure** on the mock bank page. These generate genuine
Razorpay failures across the taxonomy at no cost to the link budget — the way to
demo the classifier on real events rather than generated ones.

UPI is **not** enabled on this account (`upi: false` from
`GET /v1/methods?key_id=…`). Cards, netbanking, wallets and paylater are.

---

## Open items

- [x] Live batch, then pay a link → **Rs 8,499 recovered and attributed**
- [ ] Dashboard (Day 6 remainder) — nothing is visible yet
- [ ] Decide how to handle the recovery loop (three options above)
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
