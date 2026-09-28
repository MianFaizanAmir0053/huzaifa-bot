import { z } from "zod";

const ServerEnvironmentSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  GATEWAY_HMAC_SECRET: z.string().min(32),
  // whatsapp-web.js chat ID: country code + number, no "+" or leading 0, e.g. 923001234567@c.us
  SUPPORT_WA_ID: z.string().regex(/^[1-9]\d{7,14}@c\.us$/, "SUPPORT_WA_ID must look like 923001234567@c.us"),
  STORE_CURRENCY: z.literal("PKR").default("PKR"),
});

export type ServerEnvironment = z.infer<typeof ServerEnvironmentSchema>;

const StorageEnvironmentSchema = ServerEnvironmentSchema.pick({
  NEXT_PUBLIC_SUPABASE_URL: true,
  SUPABASE_SERVICE_ROLE_KEY: true,
  GATEWAY_HMAC_SECRET: true,
});
export type StorageEnvironment = z.infer<typeof StorageEnvironmentSchema>;

const AuthEnvironmentSchema = z
  .object({
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20).optional(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20).optional(),
    ADMIN_EMAIL: z.email(),
  })
  .transform((value, context) => {
    const publicKey = value.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? value.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!publicKey) {
      context.addIssue({ code: "custom", message: "Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY." });
      return z.NEVER;
    }
    return { supabaseUrl: value.NEXT_PUBLIC_SUPABASE_URL, supabasePublicKey: publicKey, adminEmail: value.ADMIN_EMAIL };
  });
export type AuthEnvironment = z.infer<typeof AuthEnvironmentSchema>;

export function getAuthEnvironment(): AuthEnvironment {
  return AuthEnvironmentSchema.parse(process.env);
}

const VisionEnvironmentSchema = z.object({
  GEMINI_API_KEY: z.string().min(20).optional(),
  GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
});
export type VisionEnvironment = z.infer<typeof VisionEnvironmentSchema>;

export function getVisionEnvironment(): VisionEnvironment {
  return VisionEnvironmentSchema.parse({
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || undefined,
    GEMINI_MODEL: process.env.GEMINI_MODEL || undefined,
  });
}

let cachedEnvironment: ServerEnvironment | undefined;

export function getServerEnvironment(): ServerEnvironment {
  cachedEnvironment ??= ServerEnvironmentSchema.parse(process.env);
  return cachedEnvironment;
}

export function getStorageEnvironment(): StorageEnvironment {
  return StorageEnvironmentSchema.parse(process.env);
}