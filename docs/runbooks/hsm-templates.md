# Runbook — HSM template submission to Meta

Closes [issue #20](https://github.com/khriztianmoreno/dirus/issues/20). Parallel
workstream, not an SDD change. Blocks `renewal-agent` (A2) only.

**Why this is week 1:** the Renewal Agent writes to a customer 30 days before
their policy expires. That is outside WhatsApp's 24h window, and outside the
window Meta only delivers **approved HSM templates**. Approval latency is
external and unpredictable. Every day this is not submitted is a day added to
A2's earliest possible start.

Artifacts live in [`scripts/wa-templates/`](../../scripts/wa-templates).

---

## 0. What you actually need before submitting

Templates belong to a **WhatsApp Business Account (WABA)**. To have a WABA you
need a Meta app and a business portfolio. You do *not* need a verified business
or a production phone number to submit templates for review — the sandbox WABA
that comes with a new Cloud API app is enough to get real approvals and learn
what Meta rejects.

Two separate clocks are running, and they are independent:

| Clock | What it gates | Start it |
| --- | --- | --- |
| Template review | A2 `renewal-agent` | Now (§1–§3) |
| Business Verification + production number | The pilot with real brokers | Now, in parallel (§6) |

Do not serialize them.

---

## 1. Create the Meta app and sandbox WABA

1. Go to the [Meta App Dashboard](https://developers.facebook.com/apps) → **Create App**.
2. Use case: **Connect with customers through WhatsApp** (WhatsApp Business Platform).
3. Attach it to a **business portfolio**. Create one for DIRUS if it does not exist.
4. In the app, open **WhatsApp → API Setup**. Create or link a WhatsApp Business
   Account. Record two ids from this screen:
   - **WABA ID** → this is what `submit.sh` needs, and the value that will live
     in `brokers.waba_id` per tenant.
   - **Phone number ID** (the sandbox test number) → maps to
     `brokers.wa_phone_number_id`, which resolves the tenant on every inbound
     webhook (`docs/ARCHITECTURE.md` §4).
5. Add your own phone under **test recipient numbers** so you can send to it.

**Sandbox test number limits** — know these before you plan around it:

- Meta-issued, cannot be moved to production and cannot be the pilot number.
- Only a small allowlist of recipient numbers (5) can receive messages.
- Messages are free, which makes it a good place to burn through rejections.

## 2. Get a token that can manage templates

The **Generate access token** button in API Setup gives you a token that expires
in ~24h. Fine for the first submission today, useless for the onboarding flow.

For anything beyond a one-off, create a permanent one:

1. Business Settings → **Users → System Users** → add a system user (Admin).
2. **Add Assets** → assign the WhatsApp Business Account with full control.
3. **Generate new token**, scoped to the app, with:
   - `whatsapp_business_management` — required to create and read templates.
   - `whatsapp_business_messaging` — required to actually send them.

Keep it out of the repo. Export it when running the scripts:

```bash
export WABA_ID=...
export WHATSAPP_TOKEN=...
```

## 3. Submit the templates — step by step

Two paths to the same place. **Path A (API) is the one that matters**, because
approval is per-WABA (§5) and this exact call becomes a broker onboarding step.
Path B exists for when you need to eyeball a rejection or hand the task to
someone non-technical.

Order is not negotiable either way: **fallbacks first**. They are deliberately
plain and near-certain to pass. Getting `90` and `91` approved on day one means
a rejection on the richer templates does not reset the clock to zero — the
renewal flow can be designed against the fallbacks while `01`–`04` are reworked.
That is exactly the mitigation the `docs/ARCHITECTURE.md` §14 risk table calls
for.

### Path A — via the API (recommended)

**Step 1 — collect the two credentials.** From §1 (WABA ID) and §2 (token).
Sanity-check them before submitting anything; a bad token returns an opaque
error on every template and wastes a cycle.

```bash
export WABA_ID=123456789012345
export WHATSAPP_TOKEN=EAAG...

curl -sS "https://graph.facebook.com/v23.0/$WABA_ID?fields=name,id" \
  -H "Authorization: Bearer $WHATSAPP_TOKEN"
```

Expected: a JSON object with your WABA's `name` and `id`. If you get
`"Unsupported get request"` the id is wrong; if you get an OAuth error the token
is wrong or missing `whatsapp_business_management`.

**Step 2 — fix the payment domain.** `03-renovacion_link_pago.json` ships with
the placeholder `https://pay.dirus.co/r/{{1}}`. Meta reviews the button domain.
Point it at the real one before submitting.

```bash
cd scripts/wa-templates
$EDITOR templates/03-renovacion_link_pago.json   # url + example
```

**Step 3 — make the scripts executable** (once).

```bash
chmod +x submit.sh status.sh
```

**Step 4 — submit the fallbacks.**

```bash
./submit.sh 90 91
```

Each template prints an `id` and a `status` (normally `PENDING`). A
`REJECTED BY API` line means the payload never reached review — a malformed
component, a missing `example`, or a duplicate name. Fix and re-run; only the
named templates are re-submitted.

**Step 5 — wait for the fallbacks to clear before sending the rest.**

```bash
./status.sh
```

Review is automated and usually lands within minutes, up to 24h. Once `90` and
`91` read `APPROVED`, A2 has a floor it can be designed against and the risk in
§14 is neutralized — everything after this is upside.

**Step 6 — submit the real templates.**

```bash
./submit.sh 01 02 03 04
```

**Step 7 — poll until every row resolves.**

```bash
watch -n 300 ./status.sh   # or just re-run it
```

Read **both** columns. `APPROVED` with `category: MARKETING` is not a win — Meta
re-categorized you and the per-conversation price went up. Treat it like a
rejection: reword toward the existing-policy framing in §4 and resubmit under a
new name.

**Step 8 — handle rejections.** `status.sh` prints `rejected_reason`. It is
usually terse (`INVALID_FORMAT`, `ABUSIVE_CONTENT`, `NONE`). Cross-check against
the rejection traps in §4 first — those cover most of it. A template name cannot
be reused while the rejected version exists, so either delete it or submit as
`renovacion_aviso_30d_v2`.

**Step 9 — record the outcome** per §5, and update issue #20.

### Path B — via WhatsApp Manager (UI)

Meta moves this UI regularly; treat the labels as approximate and the field
semantics as exact.

1. Open [WhatsApp Manager](https://business.facebook.com/wa/manage/) and select
   the DIRUS business portfolio and the WABA from §1.
2. **Account tools → Message templates → Create template**.
3. **Category:** `Utility`. Not Marketing. §4 explains why this is a unit
   economics decision, not a formality.
4. **Name:** copy the `name` field verbatim from the JSON file (e.g.
   `renovacion_aviso_30d`). Lowercase, digits and underscores only.
5. **Language:** `Spanish` — the plain `es` locale, not `es_MX` or `es_ES`.
6. **Body:** paste the `text` from the JSON. The `\n` sequences in the file are
   literal newlines — type them as actual line breaks.
7. **Samples:** the UI will demand an example value for every `{{n}}`. Use the
   values in the file's `example.body_text` array, in order. Skipping this is an
   automatic rejection.
8. **Footer / Buttons:** replicate the `FOOTER` and `BUTTONS` components exactly
   as the JSON defines them, including button labels. For `03`, the button is
   type **URL → Dynamic**, with the base URL and a sample full URL.
9. **Submit** and watch the status in the same list, or via `./status.sh`.

Repeat for each file, fallbacks (`90`, `91`) first.

## 4. The templates

All are `UTILITY`, language `es`, positional placeholders (`{{1}}`, `{{2}}`, …).

| File | Name | Used by | Purpose |
| --- | --- | --- | --- |
| `01-…` | `renovacion_aviso_30d` | A2 renewal cron, `renewals.status: pending → contacted` | First proactive touch, 30 days out |
| `02-…` | `renovacion_recordatorio_7d` | A2, no answer to `01` | Second touch, 7 days out |
| `03-…` | `renovacion_link_pago` | A2, `status → payment_sent` | Wompi / Mercado Pago link as a dynamic URL button |
| `04-…` | `seguimiento_pendiente` | A2, `conversations.window_expires_at` in the past | Re-opens a 24h window mid-negotiation |
| `90-…` | `fallback_aviso_vencimiento` | Fallback for `01`/`02` | Minimal, generic, no buttons |
| `91-…` | `fallback_contacto_asesor` | Fallback for `04` | Minimal window re-opener |

`04` is not optional padding. The renewal workflow lives for days or weeks
(`docs/ARCHITECTURE.md` §5.2) — the 24h window *will* expire mid-negotiation, and
without an approved template to re-open it the workflow is stuck holding a
`suspend` it can never resume.

### Why UTILITY and not MARKETING

`UTILITY` is cheaper per conversation and reviewed more predictably, because it
covers messages about a transaction the customer already has — which a policy
renewal is. Meta reclassifies to `MARKETING` on promotional language, and that
erodes the unit economics tracked in §14. So in every template body:

- No `descuento`, `promoción`, `oferta`, `aprovecha`, `no te pierdas`.
- Reference the customer's existing policy explicitly (insurer, line, expiry).
- Never cross-sell a second product.

`status.sh` prints `category` alongside `status` for this reason — a template
can be `APPROVED` *and* silently re-categorized.

### Rejection traps these templates already avoid

- Body starting or ending with a variable.
- Variables with no `example` values (an automatic rejection).
- A whole URL passed through a body variable — `03` uses a URL button with a
  dynamic suffix instead.
- Footer containing a variable (not allowed).

## 5. Record the outcome

`docs/ARCHITECTURE.md` §7.2 defines `wa_templates` (`broker_id`, `name`,
`category`, `language`, `body`, `meta_status`). That table does not exist in
`packages/db/src/schema/` yet — it arrives with the Chatwoot-less path, not with
this workstream. Until then, keep the approved names, ids, and categories in
this runbook or on issue #20.

**The per-WABA gotcha:** approval is scoped to a WABA, and the architecture gives
each broker their own (`brokers.waba_id`, and `wa_templates` is keyed by
`broker_id`). Templates approved on the sandbox WABA **do not transfer** to a
broker's production WABA. So `submit.sh` is not throwaway tooling — its logic
becomes a step in broker onboarding, and the "time-to-first-HSM-sent" metric in
§13 includes a template review cycle per broker. Plan onboarding around that.

## 6. In parallel — production access

None of this blocks §1–§3, but all of it blocks the pilot:

1. **Business Verification** of the DIRUS business portfolio (legal documents;
   takes days, sometimes longer).
2. **Add a real phone number** to the WABA and verify it. It must not be active
   on the regular WhatsApp or WhatsApp Business app — migrating an in-use number
   means deleting that account first.
3. **Display name review** for the sender name customers will see.
4. **Messaging limits** start at 250 unique recipients per 24h and scale with
   quality. Size the pilot's renewal volume against that ceiling.

---

## Done when

Templates are `APPROVED` by Meta, **or** the fallbacks are approved and the
renewal flow is designed against them. Either outcome unblocks A2.
