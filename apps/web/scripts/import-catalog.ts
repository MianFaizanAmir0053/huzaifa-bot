// Bulk catalog import: CSV manifest + local images -> draft products in Supabase.
//
//   pnpm import:catalog <manifest.csv> [--dry-run] [--suggest]
//
// Columns: sku,name,category,price_pkr,description,color,material,style_tags,aliases,sizes,images
//   style_tags / aliases / images: separated by "|"      sizes: "S:3|M:0|L:5" (optional ":VARIANT-SKU")
//   image paths are relative to the manifest file.
//
// Safe to re-run: products match by SKU, images are content-addressed, sizes are upserted.
// New products are drafts. Existing products keep their status; empty optional cells never erase existing values.
// --suggest runs Gemini on newly uploaded images and fills only empty colour/material/description/tags.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseGeminiKeys, parseModelList } from "../src/ai/gemini";
import { PRODUCT_IMAGE_MAX_BYTES } from "../src/catalog/admin/validation";
import { fillEmptyFields, suggestFromProductImage, toStoredSuggestion } from "../src/catalog/image-suggestions";
import { contentAddressedImageName, parseManifest, type ManifestRow } from "../src/catalog/import/manifest";

type RowReport = {
  line: number;
  sku: string;
  outcome: "created" | "updated" | "would_create" | "would_update" | "error";
  imagesAdded: number;
  imagesSkipped: number;
  sizes: number;
  suggested: number;
  message: string;
};

const args = process.argv.slice(2);
const manifestPath = args.find((arg) => !arg.startsWith("--"));
const dryRun = args.includes("--dry-run");
const suggest = args.includes("--suggest");

if (!manifestPath) {
  console.error("Usage: pnpm import:catalog <manifest.csv> [--dry-run] [--suggest]");
  process.exit(1);
}

function loadEnv(): Record<string, string | undefined> {
  const file = resolve(import.meta.dirname, "../.env.local");
  const fromFile = existsSync(file)
    ? Object.fromEntries(
        readFileSync(file, "utf8")
          .split(/\r?\n/)
          .filter((line) => /^[A-Z_]+=/.test(line))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      )
    : {};
  return { ...fromFile, ...process.env };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type LoadedImage = { path: string; mimeType: ManifestRow["images"][number]["mimeType"]; bytes: Buffer; sha256: string };

function loadImages(row: ManifestRow, baseDir: string): LoadedImage[] {
  return row.images.map((image) => {
    const absolute = resolve(baseDir, image.path);
    if (!existsSync(absolute)) throw new Error(`image not found: ${image.path}`);
    const size = statSync(absolute).size;
    if (size === 0 || size > PRODUCT_IMAGE_MAX_BYTES) throw new Error(`image must be 1 byte to 10 MB: ${image.path}`);
    const bytes = readFileSync(absolute);
    return { path: image.path, mimeType: image.mimeType, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

type ExistingProduct = { id: string; status: string; color: string | null; material: string | null; description: string; style_tags: string[]; aliases: string[] };

async function upsertProduct(client: SupabaseClient, row: ManifestRow, existing: ExistingProduct | null): Promise<string> {
  const product = row.product;
  if (!existing) {
    const { data, error } = await client
      .from("products")
      .insert({
        sku: product.sku,
        name: product.name,
        description: product.description,
        category: product.category,
        color: product.color,
        material: product.material,
        style_tags: product.styleTags,
        aliases: product.aliases,
        price_pkr: product.pricePkr,
        status: "draft",
      })
      .select("id")
      .single<{ id: string }>();
    if (error) throw new Error(`create failed: ${error.message}`);
    return data.id;
  }

  if (existing.status === "active" && product.pricePkr <= 0) throw new Error("live product needs a price above 0");
  const { error } = await client
    .from("products")
    .update({
      name: product.name,
      category: product.category,
      price_pkr: product.pricePkr,
      description: product.description || existing.description,
      color: product.color ?? existing.color,
      material: product.material ?? existing.material,
      style_tags: product.styleTags.length ? product.styleTags : existing.style_tags,
      aliases: product.aliases.length ? product.aliases : existing.aliases,
    })
    .eq("id", existing.id);
  if (error) throw new Error(`update failed: ${error.message}`);
  return existing.id;
}

async function main() {
  const env = loadEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (apps/web/.env.local).");
  const geminiKeys = parseGeminiKeys(env.GEMINI_API_KEY);
  const geminiModel = env.GEMINI_MODEL_PRO || env.GEMINI_MODEL || "gemini-flash-latest";
  if (suggest && !geminiKeys.length) throw new Error("--suggest needs GEMINI_API_KEY.");

  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const absoluteManifest = resolve(manifestPath!);
  const baseDir = dirname(absoluteManifest);
  const { rows } = parseManifest(readFileSync(absoluteManifest, "utf8"));
  const reports: RowReport[] = [];

  console.log(`${dryRun ? "[dry run] " : ""}${rows.length} rows from ${absoluteManifest}`);

  for (const result of rows) {
    if (!result.ok) {
      reports.push({ line: result.line, sku: result.sku, outcome: "error", imagesAdded: 0, imagesSkipped: 0, sizes: 0, suggested: 0, message: result.error });
      continue;
    }
    const row = result.row;
    const report: RowReport = { line: row.line, sku: row.product.sku, outcome: "error", imagesAdded: 0, imagesSkipped: 0, sizes: row.variants.length, suggested: 0, message: "" };
    reports.push(report);

    try {
      const images = loadImages(row, baseDir);
      const { data: existing, error: lookupError } = await client
        .from("products")
        .select("id, status, color, material, description, style_tags, aliases")
        .eq("sku", row.product.sku)
        .maybeSingle<ExistingProduct>();
      if (lookupError) throw new Error(`lookup failed: ${lookupError.message}`);

      if (dryRun) {
        report.outcome = existing ? "would_update" : "would_create";
        report.message = `${images.length} image(s) found`;
        continue;
      }

      const productId = await upsertProduct(client, row, existing);
      report.outcome = existing ? "updated" : "created";

      if (row.variants.length) {
        const { error } = await client.from("product_variants").upsert(
          row.variants.map((variant) => ({
            product_id: productId,
            size_label: variant.sizeLabel,
            normalized_size: variant.normalizedSize,
            stock_qty: variant.stockQty,
            variant_sku: variant.variantSku,
          })),
          { onConflict: "product_id,normalized_size" },
        );
        if (error) throw new Error(`sizes failed: ${error.message}`);
      }

      const { data: currentImages } = await client.from("product_images").select("storage_path, sort_order").eq("product_id", productId);
      const knownPaths = new Set((currentImages ?? []).map((image) => image.storage_path as string));
      let nextSort = Math.max(-1, ...(currentImages ?? []).map((image) => image.sort_order as number)) + 1;

      for (const image of images) {
        const storagePath = contentAddressedImageName(productId, image.sha256, image.mimeType);
        if (knownPaths.has(storagePath)) {
          report.imagesSkipped += 1;
          continue;
        }
        const { error: uploadError } = await client.storage
          .from("product-images")
          .upload(storagePath, image.bytes, { contentType: image.mimeType, upsert: true, cacheControl: "31536000" });
        if (uploadError) throw new Error(`upload ${image.path} failed: ${uploadError.message}`);

        const { data: inserted, error: insertError } = await client
          .from("product_images")
          .insert({ product_id: productId, storage_path: storagePath, sort_order: nextSort })
          .select("id")
          .single<{ id: string }>();
        if (insertError) throw new Error(`image row ${image.path} failed: ${insertError.message}`);
        knownPaths.add(storagePath);
        nextSort += 1;
        report.imagesAdded += 1;

        if (suggest && geminiKeys.length) {
          let attempt = 0;
          while (true) {
            try {
              const { suggestion, model: usedModel } = await suggestFromProductImage({ apiKey: geminiKeys, model: geminiModel, fallbackModels: parseModelList(`${env.GEMINI_MODEL_FAST ?? "gemini-flash-lite-latest"},${env.GEMINI_MODEL_FALLBACKS ?? ""}`), imageBase64: image.bytes.toString("base64"), mimeType: image.mimeType });
              await client
                .from("product_images")
                .update({ extraction_status: "complete", ai_description: suggestion.isProduct ? suggestion.description : null, ai_attributes: toStoredSuggestion(suggestion, usedModel) })
                .eq("id", inserted.id);
              const { data: current } = await client.from("products").select("color, material, description, style_tags").eq("id", productId).single();
              if (current) {
                const patch = fillEmptyFields({ color: current.color, material: current.material, description: current.description, styleTags: current.style_tags }, suggestion);
                if (Object.keys(patch).length) {
                  await client
                    .from("products")
                    .update({ color: patch.color ?? current.color, material: patch.material ?? current.material, description: patch.description ?? current.description, style_tags: patch.styleTags ?? current.style_tags })
                    .eq("id", productId);
                }
              }
              report.suggested += 1;
              break;
            } catch (error) {
              const rateLimited = error instanceof Error && "status" in error && (error as { status?: number }).status === 429;
              if (rateLimited && attempt < 2) {
                attempt += 1;
                await sleep(20_000 * attempt);
                continue;
              }
              await client.from("product_images").update({ extraction_status: "failed" }).eq("id", inserted.id);
              report.message = `suggestion failed for ${image.path}: ${error instanceof Error ? error.message : String(error)}`;
              break;
            }
          }
          await sleep(1_500); // stay well under free-tier request rates
        }
      }
      report.message ||= "ok";
    } catch (error) {
      report.message = error instanceof Error ? error.message : String(error);
      if (report.outcome === "error" || dryRun) report.outcome = "error";
      else report.message = `partially imported: ${report.message}`;
    }
  }

  const reportPath = `${absoluteManifest}.report.json`;
  writeFileSync(reportPath, JSON.stringify({ manifest: absoluteManifest, dryRun, suggest, finishedAt: new Date().toISOString(), rows: reports }, null, 2));

  for (const report of reports) {
    console.log(`line ${String(report.line).padStart(4)}  ${report.sku.padEnd(20)}  ${report.outcome.padEnd(12)}  +${report.imagesAdded} img, ${report.imagesSkipped} kept, ${report.sizes} sizes${suggest ? `, ${report.suggested} AI` : ""}  ${report.message}`);
  }
  const errors = reports.filter((report) => report.outcome === "error" || report.message.startsWith("partially")).length;
  console.log(`\n${reports.length - errors} ok, ${errors} with errors. Report: ${reportPath}`);
  process.exitCode = errors ? 2 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
