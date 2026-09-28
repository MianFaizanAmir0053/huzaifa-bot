import { z } from "zod";

const GatewayEnvironmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
  HOST: z.string().default("0.0.0.0"),
  BRAIN_BASE_URL: z.url(),
  GATEWAY_HMAC_SECRET: z.string().min(32),
  GATEWAY_ADMIN_TOKEN: z.string().min(32),
  WHATSAPP_AUTH_PATH: z.string().min(1).default("/data/wwebjs-auth"),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
});

export type GatewayEnvironment = z.infer<typeof GatewayEnvironmentSchema>;

export function getGatewayEnvironment(): GatewayEnvironment {
  return GatewayEnvironmentSchema.parse(process.env);
}