// Minimal Gemini generateContent client for structured (JSON) output.
// Kept free of Next.js/server-only imports so the catalog import CLI can reuse it.

export type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

export type GeminiJsonRequest = {
  apiKey: string;
  model: string;
  systemInstruction: string;
  parts: GeminiPart[];
  responseJsonSchema: Record<string, unknown>;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type GeminiJsonResult = { json: unknown; inputTokens: number | null; outputTokens: number | null };

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "timeout" | "blocked" | "empty" | "invalid_json",
    readonly status?: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

type GenerateContentResponse = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
};

export async function generateGeminiJson(request: GeminiJsonRequest): Promise<GeminiJsonResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": request.apiKey },
      signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.systemInstruction }] },
        contents: [{ role: "user", parts: request.parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: request.responseJsonSchema,
          maxOutputTokens: request.maxOutputTokens ?? 1024,
          temperature: request.temperature ?? 0.2,
        },
      }),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new GeminiError("Gemini request timed out", "timeout");
    }
    throw error;
  }

  const body = (await response.json().catch(() => ({}))) as GenerateContentResponse;
  if (!response.ok) {
    throw new GeminiError(`Gemini HTTP ${response.status}: ${body.error?.message ?? "request failed"}`, "http", response.status);
  }
  if (body.promptFeedback?.blockReason) throw new GeminiError(`Gemini blocked the prompt: ${body.promptFeedback.blockReason}`, "blocked");

  const candidate = body.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  if (!text.trim()) throw new GeminiError(`Gemini returned no text (finishReason ${candidate?.finishReason ?? "unknown"})`, "empty");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GeminiError("Gemini returned invalid JSON", "invalid_json");
  }

  return {
    json,
    inputTokens: body.usageMetadata?.promptTokenCount ?? null,
    outputTokens: body.usageMetadata?.candidatesTokenCount ?? null,
  };
}
