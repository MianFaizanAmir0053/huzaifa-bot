import "server-only";
import { after } from "next/server";
import { getVisionEnvironment } from "@/config/env";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { refreshProductEmbeddings } from "../embeddings";

// After an admin edit, refresh that product's meaning-search embedding once the response has been sent.
// A no-op without a Gemini key or before the embeddings migration is applied.
export function refreshSearchIndexLater(productId: string): void {
  const { geminiKeys, embeddingModel } = getVisionEnvironment();
  if (!geminiKeys.length) return;
  after(async () => {
    await refreshProductEmbeddings(createSupabaseServiceClient(), { apiKey: geminiKeys, model: embeddingModel, productIds: [productId], budgetMs: 20_000 }).catch(
      (error: unknown) => console.error("Search index refresh failed", { productId, error }),
    );
  });
}
