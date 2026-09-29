import { z } from "zod";

const GatewayEnvironmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
  HOST: z.string().default("0.0.0.0"),
  BRAIN_BASE_URL: z.url(),
  GATEWAY_HMAC_SECRET: z.string().min(32),
  GATEWAY_ADMIN_TOKEN: z.string().min(32),
  WHATSAPP_AUTH_PATH: z.string().min(1).default("/data/wwebjs-auth"),
  // The brain's agent can take ~30s for a turn; a shorter timeout would retry and then send the fallback.
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(45_000),
  // Quiet time before a customer's burst of messages is answered as one turn (never more than 6s overall).
  MERGE_WINDOW_MS: z.coerce.number().int().min(0).max(6_000).default(2_500),
  // Supabase project URL (e.g. https://xyz.supabase.co): product photos are only fetched from there.
  // Required: without it any https host with the right-looking path could be fetched from the gateway's network.
  PRODUCT_MEDIA_ORIGIN: z.url(),
  // Set in the Docker image to the system Chromium; unset locally so Puppeteer uses its bundled browser.
  PUPPETEER_EXECUTABLE_PATH: z.string().min(1).optional(),
  // Browser identity shown to WhatsApp. Keep it a current desktop Chrome; outdated ones are refused when linking.
  WHATSAPP_USER_AGENT: z.string().min(20).optional(),
});

export type GatewayEnvironment = z.infer<typeof GatewayEnvironmentSchema>;

export function getGatewayEnvironment(): GatewayEnvironment {
  return GatewayEnvironmentSchema.parse(process.env);
}