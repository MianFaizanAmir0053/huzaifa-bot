import { InboundMessageSchema } from "@huzaifa/contracts";
import { GeminiMessageClassifier } from "@/agent/classifier";
import { processInboundMessage } from "@/agent/orchestrator";
import { createSupabaseBrainRepository } from "@/catalog/repository";
import { createInboundImageLoader } from "@/catalog/inbound-media";
import { getServerEnvironment, getVisionEnvironment } from "@/config/env";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { verifyGatewaySignature } from "@/security/gateway-signature";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  let environment;
  try {
    environment = getServerEnvironment();
  } catch {
    return Response.json({ error: "Server configuration is invalid" }, { status: 503 });
  }

  const authenticated = verifyGatewaySignature({
    body,
    timestamp: request.headers.get("x-huzaifa-timestamp"),
    signature: request.headers.get("x-huzaifa-signature"),
    secret: environment.GATEWAY_HMAC_SECRET,
  });
  if (!authenticated) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsedMessage = InboundMessageSchema.safeParse(payload);
  if (!parsedMessage.success) {
    return Response.json(
      { error: "Invalid message", details: parsedMessage.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const repository = createSupabaseBrainRepository(
      environment.NEXT_PUBLIC_SUPABASE_URL,
      environment.SUPABASE_SERVICE_ROLE_KEY,
    );
    const vision = getVisionEnvironment();
    // Without a Gemini key the orchestrator falls back to keyword rules (greeting, handoff, size, raw-text search).
    const classifier = vision.GEMINI_API_KEY
      ? new GeminiMessageClassifier({
          apiKey: vision.GEMINI_API_KEY,
          model: vision.GEMINI_MODEL,
          loadImage: createInboundImageLoader(createSupabaseServiceClient()),
        })
      : undefined;
    const result = await processInboundMessage(parsedMessage.data, {
      repository,
      supportChatId: environment.SUPPORT_WA_ID,
      classifier,
    });
    return Response.json(result);
  } catch (error) {
    console.error("Gateway message processing failed", { eventId: parsedMessage.data.eventId, error });
    return Response.json({ error: "Message processing failed" }, { status: 500 });
  }
}
