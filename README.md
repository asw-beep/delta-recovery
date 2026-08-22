# Delta

**Revenue recovery that only chases the money that wouldn't come back on its own.**

Built for Razorpay Buildathon 2026 — Track 03, AI Revenue Recovery.

---

## The idea

Most failed payments recover by themselves. The customer taps again, the bank
comes back up, the card gets topped up. A recovery system that contacts everyone
who failed is spending money and customer patience to buy revenue it was going
to get anyway.

So Delta doesn't optimise the probability that a customer pays. It optimises the
**incremental** rupee:

```
uplift(a|x) = P(pay | x, action a) − P(pay | x, do nothing)
EV(a|x)     = uplift(a|x) · amount − cost(a) − λ · fatigue(x, a)
```

Every intervention has to earn its place against doing nothing. Most don't.

## How it works

```
Razorpay webhook ─┐
                  ├─→ normalise → detect risk → diagnose → score → decide → execute → verify
reconciliation ───┘                                          │
                                                    policy engine
                                              ALLOW / DELAY / ESCALATE / STOP
```

The LLM writes explanations and proposes actions from a fixed enum. It never
computes a number and never authorises a payment. Scoring, expected value,
policy evaluation and execution are deterministic, tested TypeScript — so
"what if the model hallucinates?" has a code-path answer, not a reassurance.

## Status

In development. See [DECISIONS.md](DECISIONS.md) for the locked architecture,
the verified Razorpay constraints this is built around, and the evaluation plan.

Research behind those decisions is in [`docs/`](docs/).

## Stack

Next.js 16 · TypeScript · Postgres (Supabase) · Drizzle · Tailwind + shadcn/ui ·
Razorpay Node SDK · Vercel AI SDK (Gemini, Groq fallback) · scikit-learn for
offline training

## Running locally

```bash
npm install
cp .env.example .env      # fill in Razorpay test keys and DATABASE_URL
npm run db:push
npm run dev
```

Webhooks need a public URL — tunnel with `cloudflared` or `ngrok` and register
the endpoint in the Razorpay dashboard under Test Mode.
