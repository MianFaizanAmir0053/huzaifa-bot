# Operations Runbook

## 1. Supabase

1. Create a Supabase project and apply `supabase/migrations/202609280001_initial_schema.sql` with the Supabase CLI or SQL editor.
2. Create a private `inbound-media` bucket and a `product-images` bucket. Keep inbound media private.
3. Create the owner with Supabase email/password authentication.
4. Add that owner to the allowlist:

```sql
insert into public.admin_users (user_id)
select id from auth.users where email = 'owner@example.com';
```

5. Put the project URL, anon key, and service-role key in Vercel. Never expose the service-role key through a `NEXT_PUBLIC_` variable.

## 2. Vercel

Set the root directory to `apps/web` and configure every variable in `apps/web/.env.example`. Generate independent random values for `GATEWAY_HMAC_SECRET` and `GATEWAY_ADMIN_TOKEN`; each should be at least 32 characters. Use the same HMAC secret in Railway.

The message endpoint is `POST /api/gateway/messages`. It requires:

- `x-huzaifa-timestamp`: current Unix time in seconds
- `x-huzaifa-signature`: lowercase SHA-256 HMAC of `<timestamp>.<raw-body>`

Requests older than five minutes are rejected.

## 3. Railway Gateway

1. Deploy from the repository root using `apps/gateway/railway.json`.
2. Configure every variable in `apps/gateway/.env.example`.
3. Attach a persistent volume and mount it at `/data`.
4. Set `WHATSAPP_AUTH_PATH=/data/wwebjs-auth`.
5. Confirm `GET /health/live` returns `200`.
6. Call `GET /session` with `Authorization: Bearer <GATEWAY_ADMIN_TOKEN>` and scan the returned QR data URL.
7. Restart the service and confirm `GET /health/ready` returns `200` without another QR scan.

## 4. Recovery

- `qr_pending`: scan the QR shown by the protected session endpoint.
- `disconnected`: restart once; if still disconnected, deliberately call `POST /session/logout` and relink.
- webhook `401`: verify both services use the same HMAC secret and their clocks are synchronized.
- webhook `503`: correct missing or invalid Vercel environment values.
- webhook `500`: inspect Vercel logs by event ID and verify the migration and service-role credentials.
- no replies during handoff: expected while the conversation state is `human_active`; resume support is part of the upcoming admin conversation screen.

## 5. Security and Retention

- Use a dedicated WhatsApp number with no irreplaceable message history.
- Rotate the gateway token and HMAC secret together during a maintenance window.
- Never log image bytes, service-role keys, signed URLs, or full phone numbers.
- Delete private inbound media after 30 days once the cleanup route is enabled.
- Review local consent and privacy requirements before processing real customer data.