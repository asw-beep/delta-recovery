# Synthetic data — format, rules and context

For populating Delta with merchant traffic that exercises paths the test account
has not produced organically. Hand this file to a generator; the output loads
with `npx tsx scripts/load-synthetic.ts <file.json>`.

---

## The one rule that cannot bend

Synthetic data is legitimate as **input** and never as a **result**.

`eval/generate.py` already produces 1,900 synthetic items — that is how the
evaluation works, and it is fine, because the *generating process* is published
and the numbers it produces are labelled as coming from it.

What DECISIONS.md §2 forbids is a **fabricated outcome**: a recovered figure, an
uplift, or an evaluation number that no committed run produced. So:

| Allowed | Forbidden |
|---|---|
| Synthetic payments, orders, invoices as pipeline input | Writing risk items, decisions or outcomes directly |
| Letting detection, scoring and policy run over them | Typing a recovered total into the UI |
| Simulated execution, clearly labelled `SIM` | Presenting a synthetic recovery as real money |

**Every synthetic entity must be identifiable as synthetic, forever.** Two
independent markers, both required:

1. The id carries a `SYN` segment — `pay_SYN00001`, `order_SYN00001`
2. `notes.synthetic` is the string `"true"`

The loader refuses any record missing either. The dashboard badges anything
descended from them, exactly as it badges `SIM` execution — a screenshot must
never be mistakable for live Razorpay traffic.

---

## File format

One JSON file. Three arrays; all optional, but a payment referencing a missing
order is rejected.

```json
{
  "_meta": {
    "generated_at": "2026-08-23T16:30:00Z",
    "generator": "gpt-5 / claude / script name",
    "seed": 4711,
    "note": "one line on what this batch is meant to exercise"
  },
  "orders":   [ /* RzpOrder   */ ],
  "payments": [ /* RzpPayment */ ],
  "invoices": [ /* RzpInvoice */ ]
}
```

Shapes mirror Razorpay's API exactly, because they are fed through the same
`upsertOrder` / `upsertPayment` / `upsertInvoice` used for real webhooks. That
is deliberate: synthetic rows take the identical code path to live traffic, so
loading them tests the real ingestion rather than a parallel one.

### Order

```json
{
  "id": "order_SYN00001",
  "entity": "order",
  "amount": 249900,
  "amount_paid": 0,
  "amount_due": 249900,
  "currency": "INR",
  "receipt": "rcpt_syn_00001",
  "status": "attempted",
  "attempts": 1,
  "created_at": 1755960000,
  "notes": { "synthetic": "true", "customer_email": "priya.nair@example.com" }
}
```

- `amount`, `amount_paid`, `amount_due` are **paise**. `amount_due` must equal
  `amount - amount_paid`.
- `status`: `created` (never attempted) · `attempted` (a payment failed against
  it) · `paid`.
- `created_at` is **unix seconds**.
- Only `created`/`attempted` orders with `amount_due > 0` can become abandoned
  checkouts, and only once they are older than **2 hours** (`ABANDON_DWELL_HOURS`).

### Payment

```json
{
  "id": "pay_SYN00001",
  "entity": "payment",
  "amount": 249900,
  "currency": "INR",
  "status": "failed",
  "order_id": "order_SYN00001",
  "method": "card",
  "bank": "HDFC",
  "wallet": null,
  "vpa": null,
  "email": "priya.nair@example.com",
  "contact": "+919845012345",
  "created_at": 1755960000,
  "error_code": "BAD_REQUEST_ERROR",
  "error_description": "Your payment could not be completed due to insufficient account balance.",
  "error_source": "customer",
  "error_step": "payment_authorization",
  "error_reason": "insufficient_funds",
  "notes": { "synthetic": "true" }
}
```

- `status: "failed"` is what opens a `failed_payment` risk item.
- `contact` is the **customer identity key** — phone takes precedence over
  email. Reuse a contact across payments to make one person, which is how the
  fatigue cap is exercised.

### Invoice

```json
{
  "id": "inv_SYN00001",
  "entity": "invoice",
  "status": "issued",
  "amount": 1875000,
  "amount_paid": 0,
  "amount_due": 1875000,
  "currency": "INR",
  "short_url": null,
  "customer_details": {
    "name": "Meridian Labs Pvt Ltd",
    "email": "accounts@meridianlabs.example.com",
    "contact": "+919845100200"
  },
  "order_id": null,
  "expire_by": 1755100000,
  "issued_at": 1753900000,
  "created_at": 1753900000,
  "notes": { "synthetic": "true" }
}
```

- Only `issued` and `partially_paid` are actionable — Razorpay rejects
  `notify_by` for anything else, so other statuses never enter the queue.
- **`expire_by` must be in the past** for the invoice to be overdue. This is the
  only way to demonstrate the receivables class: the live Razorpay API refuses a
  backdated `expire_by`, which is why this class has never appeared on real data.

---

## `error_reason` — a closed set

**An unmapped reason raises rather than defaulting to a bucket**, by design: a
wrong bucket is a wrong decision about money. Use only these.

| Class | Values | What it means for recovery |
|---|---|---|
| `TRANSIENT` | `gateway_technical_error`, `bank_technical_error`, `payment_timed_out`, `server_error` | Infrastructure blipped. **High self-recovery** — uplift here should be low |
| `CUSTOMER_FIXABLE` | `payment_cancelled`, `authentication_failed`, `incorrect_cvv`, `insufficient_funds`, `insufficient_fund`, `invalid_otp`, `card_number_invalid` | The customer can complete it. Timing is the lever |
| `INSTRUMENT_DEAD` | `card_expired`, `debit_instrument_blocked`, `debit_instrument_inactive`, `card_not_enrolled`, `card_disabled_for_online_payments`, `international_transaction_not_allowed` | Same instrument cannot succeed; only an alternative method has uplift |
| `DO_NOT_TOUCH` | `payment_risk_check_failed` | Bank flagged fraud → **always `ESCALATE`**, never automated |
| `OPAQUE` | `card_declined`, `payment_failed`, `transaction_limit_exceeded` | Bank said nothing useful. Where the model earns its keep |

Matching `error_source` / `error_step`, for realism:

- `error_source`: `customer` · `bank` · `gateway` · `business` · `issuer`
- `error_step`: `payment_initiation` · `payment_authentication` · `payment_authorization` · `payment_response`

---

## Context for realistic generation

An Indian merchant on Razorpay. Payment mix should look like India, not the US.

**Method mix** — UPI dominates: roughly `upi` 55% · `card` 25% · `netbanking`
12% · `wallet` 8%.

- `upi` → set `vpa` like `priya@okhdfcbank`, `rohit@ybl`, `anjali@paytm`,
  `vikram@okaxis`; leave `bank`/`wallet` null
- `card` → set `bank` to `HDFC`, `ICICI`, `SBIN`, `UTIB` (Axis), `KKBK` (Kotak)
- `netbanking` → same bank codes
- `wallet` → `paytm`, `phonepe`, `freecharge`, `mobikwik`

**Names and contacts** — Indian names, `+91` numbers starting `+9198`/`+9199`/
`+9170`, `example.com` domains only.

**Amounts (paise)** — pick a merchant archetype and stay consistent:

| Archetype | Typical range | Notes |
|---|---|---|
| D2C commerce | ₹499 – ₹4,999 (`49900`–`499900`) | Long tail, many small |
| Subscription SaaS | ₹999 – ₹9,999 | Repeat customers, monthly cadence |
| B2B receivables | ₹15,000 – ₹2,00,000 | Few, large, invoice-based |

**Timestamps** — spread across the last 5–7 days, not one instant. Hours since
failure is a scoring feature, and clustering everything at one moment makes the
scores degenerate. Weight toward evening IST (18:00–22:00), which is when Indian
consumer payments peak.

**Repetition** — reuse ~30% of contacts across multiple payments. Some customers
should have prior successes and prior failures; that is what customer history
features read.

---

## Distribution targets — what makes each path fire

Aim for a batch of **60–120 payments, 20–40 orders, 8–15 invoices**. To exercise
every verdict, include at least:

| Target | How to produce it | Expected verdict |
|---|---|---|
| High-value escalation | `amount ≥ 2500000` (₹25,000) | `ESCALATE` |
| Fraud escalation | `error_reason: "payment_risk_check_failed"` | `ESCALATE`, never automated |
| Fatigue stop | One `contact` appearing on ≥4 failed payments in 7 days | `STOP` after the 3rd contact |
| EV-floor stop | `amount ≤ 100000` (₹1,000) with a low-uplift class | `STOP` — below the ₹5 net floor |
| Uplift-floor stop | `TRANSIENT` reasons on small amounts | `STOP` — would recover anyway |
| Ordinary allow | ₹2,000–₹20,000, `CUSTOMER_FIXABLE` | `ALLOW` |
| Abandoned checkout | Order `attempted`, `amount_due > 0`, `created_at` > 2h ago | class appears |
| Overdue receivable | Invoice `issued`, `expire_by` in the past | class appears |
| Self-recovery | Order `paid` whose earlier payment `failed` | closes as self-recovered, **no credit claimed** |

That last row matters most. Self-recovery is the thesis, so a batch with none of
it makes the product look like every other dunning tool. **Roughly 25–30% of
failed payments should be followed by a successful payment on the same order** —
that is what the evaluation measures, and it should be visible in live data too.

---

## Suggested batch composition

```
payments   90
  failed   62      spread across all five taxonomy classes,
                   weighted OPAQUE 30% · CUSTOMER_FIXABLE 30% ·
                   TRANSIENT 20% · INSTRUMENT_DEAD 15% · DO_NOT_TOUCH 5%
  captured 28      of which ~18 follow a failed payment on the same order
                   (this is the self-recovery signal)

orders     32
  attempted 18     older than 2h, unpaid  → abandoned checkout
  created    6     older than 2h, unpaid  → abandoned checkout
  paid       8     carrying the self-recoveries

invoices   12
  issued     9     expire_by in the past  → overdue receivable
  paid       3     control group
```

---

## Loading it

```bash
npx tsx scripts/load-synthetic.ts data/synthetic-batch.json          # validate only
npx tsx scripts/load-synthetic.ts data/synthetic-batch.json --commit # write
npx tsx scripts/load-synthetic.ts --purge                            # remove all synthetic rows
```

The loader validates every record against the rules above **before writing
anything** — unmapped `error_reason`, missing synthetic markers, `amount_due`
mismatches and dangling `order_id` references all fail the batch rather than
loading a partial one.

`--purge` exists because synthetic data must be removable in one command. Demo
day should be a deliberate choice between live-only and mixed, not whatever
happens to be in the database.
