import { createHash } from "node:crypto";
import type { CatalogItem, SearchFilters, SearchResult } from "./search";

// Meaning-based search: complements the keyword vocabulary for words it doesn't know ("frock", "maxi",
// "pishwas", misspellings, Urdu product words). Products and queries are embedded with Gemini; the database
// returns the closest active products (public.match_products).

// Calibrated on the eval catalog: gemini-embedding-001 put the right item first for "burqa", "chadar ya stole",
// "3 piece jora", "office formal shirt", "trouser" and "عبایا", while unrelated asks ("watches", "shoes",
// "mobile cover") scored ≤ 0.57 with no clear winner. gemini-embedding-2 ranked well but separated worse.
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
// Candidates the model may consider (it judges the fit); anything below isn't plausibly related.
export const MIN_SEMANTIC_SIMILARITY = 0.55;
// Without the model (rules fallback) only a clear winner is trusted.
const CONFIDENT_SIMILARITY = 0.6;
const CONFIDENT_MARGIN = 0.03;

export type SemanticHit = { id: string; similarity: number };

// The top hit when it clearly stands out, for replies built without the model.
export function confidentHit(hits: readonly SemanticHit[]): SemanticHit | null {
  const [top, second] = [...hits].sort((a, b) => b.similarity - a.similarity);
  if (!top || top.similarity < CONFIDENT_SIMILARITY) return null;
  return !second || top.similarity - second.similarity >= CONFIDENT_MARGIN ? top : null;
}

// What a product is embedded as. Everything a customer might call it, never prices or stock.
export function productEmbeddingText(product: Pick<CatalogItem, "name" | "category" | "color" | "material" | "styleTags" | "aliases" | "description" | "aiText">): string {
  return [
    product.name,
    `Item: ${product.category}`,
    product.color ? `Colour: ${product.color}` : "",
    product.material ? `Fabric: ${product.material}` : "",
    product.styleTags.length ? `Style: ${product.styleTags.join(", ")}` : "",
    product.aliases.length ? `Also called: ${product.aliases.join(", ")}` : "",
    product.description,
    product.aiText ? `Photo: ${product.aiText}` : "",
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 6_000);
}

// Stored next to the embedding: when neither the text nor the model changed, the product isn't embedded again.
export function embeddingSourceHash(text: string, model: string): string {
  return createHash("sha256").update(`${model}\n${text}`).digest("hex").slice(0, 40);
}

// The message to search by meaning, or null when the keyword search already understood it (or it isn't
// about products: greetings, phone numbers and addresses, long stories).
export function semanticQueryFor(text: string, filters: SearchFilters, search: SearchResult | null): string | null {
  const unknown = (filters.text ?? "").split(/\s+/).filter((word) => word.length >= 3);
  if (unknown.length === 0) return null;
  if (search && search.matches.length >= 2) return null;
  if (/\d{7,}/.test(text.replace(/[\s-]/g, ""))) return null;
  if (text.split(/\s+/).length > 30) return null;
  return text.trim().slice(0, 300);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}
