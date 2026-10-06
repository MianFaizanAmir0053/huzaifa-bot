# Huzaifa WhatsApp Catalog Agent

A WhatsApp shopping assistant for a clothing shop. Customers message a dedicated WhatsApp number in English, Urdu or Roman Urdu (text or a product photo); the bot finds matching products, answers with live PKR prices and per-size availability from Supabase, and takes orders (items, name, phone, address → a priced summary → the customer confirms → the owner confirms and ships it from the admin). Customers can ask for a person at any time; the owner is alerted on WhatsApp and the bot steps back as soon as the owner replies.

Gemini writes the words. Prices, totals, sizes and stock are always rendered from the database, never written by the model.

## Workspace

- `apps/web` — Next.js (Vercel): admin console, signed gateway API, agent brain, catalog import CLI
- `apps/gateway` — Fastify + `whatsapp-web.js` (Railway): WhatsApp session, per-chat queue, retries, delivery reports
- `packages/contracts` — shared Zod contracts between gateway and brain
- `supabase/migrations` — schema, search, RLS, handoff, orders and meaning-search (pgvector) functions
- `docs/runbook.md` — setup, deployment and recovery

## Requirements

- Node.js 22+ and pnpm 10.34+
- A Supabase project
- A Gemini API key (optional: without it the bot falls back to keyword rules)
- Railway (always-on, persistent volume) for the gateway; Vercel for the web app
- A dedicated WhatsApp number that is not your personal or support number

## Local setup

```powershell
pnpm install
Copy-Item apps/web/.env.example apps/web/.env.local
Copy-Item apps/gateway/.env.example apps/gateway/.env
# fill both files; GATEWAY_HMAC_SECRET and GATEWAY_ADMIN_TOKEN must match in both
pnpm --filter @huzaifa/web create-admin     # needs ADMIN_PASSWORD in the environment
pnpm --filter @huzaifa/web dev              # http://localhost:3000/admin
pnpm --filter @huzaifa/gateway dev          # http://localhost:3001, QR at /admin/whatsapp
```

## Adding many products at once

The shop sends photos plus one line per product: a **code**, the **price** and the **sizes with how many of each**. Everything else (name, category, colour, fabric, tags, description) is read from the main photo by Gemini, unless the sheet already says it.

1. Make a folder `catalog/` in the repo root (git ignores it) with:
   - either the sheet as CSV (start from `docs/catalog/products-template.csv`; Excel/Google Sheets → Download → CSV), with columns `code, price, sizes` and optionally `name, category, colour, fabric, notes`;
   - or `products.txt` with one WhatsApp-style line per product, `K12 | 3500 | S2 M3 L1 | lawn, 3 piece` (a whole copied WhatsApp chat works: other lines are skipped);
   - the photos, named by code (`K12-1.jpg`, `K12-2.jpg`, the `-1` photo is the main one) or in a folder per code (`K12/…`).

   Sizes are written like `S2 M3 L1`, `Free 5` or `32-2 34-1`.
2. Check it without changing anything:
   ```powershell
   pnpm import:products ./catalog --dry-run
   ```
   It lists the photos found per product, what the AI will fill, rows with problems, and photos that match no code.
3. Import and put complete products live:
   ```powershell
   pnpm import:products ./catalog --publish
   ```
   Products missing something stay drafts and the report says what. Re-running is safe: products match by code, photos aren't uploaded twice, sizes are updated (handy for stock updates). Live products are added to meaning and photo search straight away.

A short guide to send the shop owner is in `docs/catalog/client-guide.md`.

## How a reply is made

1. **Gateway** waits ~2.5 s to merge a burst of messages from one chat, shows "typing…", and forwards one turn. It also watches its own WhatsApp session (restarts a hung or crashed browser, notices when messages stop arriving) and answers messages that came in while it was down (not at night, not from before the number was linked), with an apology for the wait.
2. **Quick checks (no AI):** duplicate, paused chat, spam limit, "human/call" requests.
3. **Memory:** last ~16 messages (customer, bot and owner), a running summary, the customer's name/city/language, products already shown.
4. **Search (no AI):** colour, garment, size and budget are read from the words (English, Roman Urdu, Urdu; laal = red, kameez = shirt…); results are split into exact matches and honest alternatives.
5. **Meaning search:** words the vocabulary doesn't know ("chadar", "burqa", "pishwas", misspellings) are embedded with Gemini and matched against product embeddings in the database (pgvector); the closest items are offered as guesses.
   **Photo search:** a customer's photo is embedded with Gemini's image model and matched against the shop's product photos (pgvector); the closest few go to the agent with their shop photos attached, so it compares them by eye before calling anything the same item.
6. **Agent (Gemini):** writes 1–3 short messages in the customer's language and tone, can call search/product/browse tools (≤2 rounds, 30 s budget), builds the customer's order, and may ask for a person. The language to answer in is detected by code and pinned.
7. **Fact check (code):** products appear only as `{{product:P1}}` / `{{size:P1:M}}` / `{{sizes:P1}}` tags and photo cards; names, prices and stock are filled from the database; typed prices, stock counts, untagged size claims and false "order placed" claims are rejected (one rewrite, then removed).
8. **Orders (code):** the order the model describes is checked against the catalog and stock; when it's complete the customer gets a priced summary (items, delivery, total), and it's placed only when they confirm that exact summary. The owner gets a WhatsApp alert and confirms, ships or cancels it under **Orders** (stock is taken on confirm).
   A customer who saw the summary and went quiet gets one reminder (during opening hours, never at night); the owner gets a note about carts that stay quiet and placed orders still waiting for confirmation. The gateway asks the brain for these every 5 minutes (`/api/gateway/followups`).
9. **Handoff:** the owner gets an alert; the bot keeps helping until the owner replies in that chat, then steps back until "Resume bot".
10. **After the reply:** the conversation summary is refreshed in the background.

If Gemini is down, rule-based replies take over (greetings, search with closest items, overview, and handing buyers and open orders to the team) so a customer is never left hanging.

`pnpm --filter @huzaifa/web eval` scores the agent on ~46 real-style messages including a full order (`apps/web/evals`); `--rules` gives the rules-only baseline, `--no-semantic` skips meaning search. Evals use your Gemini quota (about 50–90 requests a run).

## Checks

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Admin

- **Products** — create/edit, images (direct-to-storage upload), sizes and stock, publish/archive, Gemini image suggestions, meaning-search index
- **Conversations** — who needs a person, message history, lead status, orders, private notes, Resume bot, delete customer data
- **Orders** — new orders to confirm (takes stock), ship (optional tracking number), deliver or cancel (gives stock back), each optionally messaging the customer on WhatsApp; open carts
- **WhatsApp** — QR linking, connection status, restart/unlink
- **Shop info** — delivery, payment, returns, hours, address, order taking and delivery charges, order reminders and owner notes, tone notes and real example chats the assistant learns its voice from

`whatsapp-web.js` is unofficial and can break or get a number banned. Use a dedicated number and keep the transport boundary (`apps/gateway/src/transport.ts`) so the gateway can move to the Meta Cloud API later.
