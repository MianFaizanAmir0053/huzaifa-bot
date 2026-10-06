// Bulk product import: one folder with a sheet (CSV) and the product photos -> products in Supabase.
//
//   pnpm import:products <folder or sheet.csv> [--dry-run] [--publish] [--suggest]     (from the repo root)
//
// The sheet (exported from Excel or Google Sheets as CSV) has one row per product. Needed: code, price, sizes
// ("K12", "3500", "S2 M3 L1"). Optional: name, category, colour, fabric, notes, tags, other names, photos.
// Column names are forgiving (see src/catalog/import/product-sheet.ts); docs/catalog/products-template.csv is a start.
// Photos are found by code: "K12.jpg", "K12-1.jpg", "K12 (2).png", or anything in a folder named "K12".
//
// Gemini reads the main photo and fills whatever the sheet left empty: name, category, colour, fabric, tags and
// description. --publish puts a product live once it has a name, category, price, photo and sizes; otherwise it
// stays a draft and the report says what's missing. --suggest also reads every other new photo.
// Safe to re-run: products match by code (SKU), photos are content-addressed, sizes are upserted, and an existing
// product keeps its name and category when the sheet leaves them empty. Live products get their search index
// (meaning and photo search) updated at the end.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseGeminiKeys, parseModelList } from "../src/ai/gemini";
import { getPublishBlockers, parseProductFields, PRODUCT_IMAGE_MAX_BYTES, type ProductFormValues, type VariantInput } from "../src/catalog/admin/validation";
import { refreshProductEmbeddings } from "../src/catalog/embeddings";
import { refreshProductImageEmbeddings } from "../src/catalog/image-embeddings";
import { suggestFromProductImage, toStoredSuggestion, type ImageSuggestion } from "../src/catalog/image-suggestions";
import { contentAddressedImageName, imageMimeFromPath, type ManifestImage } from "../src/catalog/import/manifest";
import { fillFromSuggestion, matchPhotos, parseProductLines, parseProductSheet } from "../src/catalog/import/product-sheet";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_IMAGE_EMBEDDING_MODEL } from "../src/catalog/semantic";

type RowReport = {
  line: number;
  sku: string;
  outcome: "created" | "updated" | "would_create" | "would_update" | "error";
  photos: number;
  imagesAdded: number;
  imagesSkipped: number;
  sizes: number;
  aiFilled: string[];
  published: boolean;
  message: string;
};

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("--"));
const dryRun = args.includes("--dry-run");
const publish = args.includes("--publish");
const suggest = args.includes("--suggest");

if (!target) {
  console.error("Usage: pnpm import:products <folder, sheet.csv or lines.txt> [--dry-run] [--publish] [--suggest]");
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

// A folder must hold exactly one sheet: a CSV, or a .txt of WhatsApp-style lines ("K12 | 3500 | S2 M3 L1").
function findSheet(path: string): string {
  if (!statSync(path).isDirectory()) return path;
  const sheets = readdirSync(path).filter((name) => /\.(?:csv|txt)$/i.test(name));
  if (sheets.length !== 1) {
    throw new Error(
      sheets.length
        ? `More than one sheet in ${path}: ${sheets.join(", ")}. Pass the one to import.`
        : `No sheet in ${path}: add the sheet exported as CSV, or a .txt with one "code | price | sizes" line per product.`,
    );
  }
  return join(path, sheets[0]!);
}

// Every photo under the sheet's folder (a few levels deep), as paths relative to it.
function listPhotos(baseDir: string, dir = baseDir, depth = 0): string[] {
  if (depth > 3) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listPhotos(baseDir, full, depth + 1);
    return imageMimeFromPath(entry.name) ? [relative(baseDir, full)] : [];
  });
}

type LoadedImage = { path: string; mimeType: ManifestImage["mimeType"]; bytes: Buffer; sha256: string };

function loadImages(images: readonly ManifestImage[], baseDir: string): LoadedImage[] {
  return images.map((image) => {
    const absolute = resolve(baseDir, image.path);
    if (!existsSync(absolute)) throw new Error(`photo not found: ${image.path}`);
    const size = statSync(absolute).size;
    if (size === 0 || size > PRODUCT_IMAGE_MAX_BYTES) throw new Error(`photo must be 1 byte to 10 MB: ${image.path}`);
    const bytes = readFileSync(absolute);
    return { path: image.path, mimeType: image.mimeType, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

type ExistingProduct = { id: string; status: string; name: string; category: string; color: string | null; material: string | null; description: string; style_tags: string[]; aliases: string[] };

async function upsertProduct(client: SupabaseClient, product: ProductFormValues, existing: ExistingProduct | null): Promise<string> {
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

async function saveSizes(client: SupabaseClient, productId: string, variants: readonly VariantInput[]): Promise<void> {
  if (!variants.length) return;
  const { error } = await client.from("product_variants").upsert(
    variants.map((variant) => ({
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

async function main() {
  const env = loadEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (apps/web/.env.local).");
  const geminiKeys = parseGeminiKeys(env.GEMINI_API_KEY);
  const visionModel = env.GEMINI_MODEL_PRO || env.GEMINI_MODEL || "gemini-flash-latest";
  const visionFallbacks = parseModelList(`${env.GEMINI_MODEL_FALLBACKS ?? ""},${env.GEMINI_MODEL_FAST ?? "gemini-flash-lite-latest"}`);
  if (suggest && !geminiKeys.length) throw new Error("--suggest needs GEMINI_API_KEY.");

  // Reads one photo with Gemini; a rate limit waits and tries again twice (free-tier keys hit it in bursts).
  const readPhoto = async (image: LoadedImage): Promise<{ suggestion: ImageSuggestion; model: string }> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await suggestFromProductImage({ apiKey: geminiKeys, model: visionModel, fallbackModels: visionFallbacks, imageBase64: image.bytes.toString("base64"), mimeType: image.mimeType });
        await sleep(1_500); // stay well under free-tier request rates
        return result;
      } catch (error) {
        const rateLimited = error instanceof Error && "status" in error && (error as { status?: number }).status === 429;
        if (!rateLimited || attempt >= 2) throw error;
        await sleep(20_000 * (attempt + 1));
      }
    }
  };

  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // pnpm runs this inside apps/web; a relative path means relative to where the command was typed.
  const sheetPath = findSheet(resolve(process.env.INIT_CWD ?? process.cwd(), target!));
  const baseDir = dirname(sheetPath);
  const sheetText = readFileSync(sheetPath, "utf8");
  const { rows, ignoredColumns } = /\.txt$/i.test(sheetPath) ? { ...parseProductLines(sheetText), ignoredColumns: [] } : parseProductSheet(sheetText);
  const photos = listPhotos(baseDir);
  const usedPhotos = new Set<string>();
  const reports: RowReport[] = [];
  const touched: string[] = [];

  console.log(`${dryRun ? "[dry run] " : ""}${rows.length} products in ${sheetPath}, ${photos.length} photos in the folder`);
  if (ignoredColumns.length) console.log(`Ignored columns: ${ignoredColumns.join(", ")}`);

  for (const result of rows) {
    if (!result.ok) {
      reports.push({ line: result.line, sku: result.sku, outcome: "error", photos: 0, imagesAdded: 0, imagesSkipped: 0, sizes: 0, aiFilled: [], published: false, message: result.error });
      continue;
    }
    const row = result.row;
    const report: RowReport = { line: row.line, sku: row.sku, outcome: "error", photos: 0, imagesAdded: 0, imagesSkipped: 0, sizes: row.variants.length, aiFilled: [], published: false, message: "" };
    reports.push(report);

    try {
      const listed = row.images.length ? row.images : matchPhotos(row.sku, photos).map((path) => ({ path, mimeType: imageMimeFromPath(path)! }));
      for (const image of listed) usedPhotos.add(resolve(baseDir, image.path));
      const images = loadImages(listed, baseDir);
      report.photos = images.length;

      const { data: existing, error: lookupError } = await client
        .from("products")
        .select("id, status, name, category, color, material, description, style_tags, aliases")
        .eq("sku", row.sku)
        .maybeSingle<ExistingProduct>();
      if (lookupError) throw new Error(`lookup failed: ${lookupError.message}`);

      // An existing product keeps its name and category unless the sheet gives new ones.
      let fields = { ...row.fields, name: row.fields.name || existing?.name || "", category: row.fields.category || existing?.category || "" };
      const needsPhotoReading = !fields.name || !fields.category;
      let mainPhoto: { suggestion: ImageSuggestion; model: string } | null = null;

      if (dryRun) {
        const missing = [!fields.name && "name", !fields.category && "category"].filter(Boolean);
        const fillable = images.length > 0 && geminiKeys.length > 0;
        // The real run would stop here: nothing to name the product by.
        report.outcome = missing.length && !fillable ? "error" : existing ? "would_update" : "would_create";
        report.message = [
          images.length ? `photos: ${images.map((image) => image.path).join(", ")}` : "no photos found",
          missing.length ? (fillable ? `AI will fill ${missing.join(" and ")} from the photo` : `add a ${missing.join(" and ")} in the sheet, or a photo for AI to read`) : "",
        ]
          .filter(Boolean)
          .join("; ");
        continue;
      }

      if (images.length && geminiKeys.length && (needsPhotoReading || suggest || !existing)) {
        try {
          mainPhoto = await readPhoto(images[0]!);
          const filled = fillFromSuggestion(fields, mainPhoto.suggestion);
          fields = filled.fields;
          report.aiFilled = filled.filled;
          if (!mainPhoto.suggestion.isProduct) report.message = "AI says the main photo doesn't show a product; ";
        } catch (error) {
          report.message = `AI couldn't read the photo (${error instanceof Error ? error.message : String(error)}); `;
        }
      }

      const product = parseProductFields({ sku: row.sku, ...fields });
      if (!product.success) {
        const missing = [!fields.name && "name", !fields.category && "category"].filter(Boolean);
        throw new Error(missing.length ? `${report.message}add a ${missing.join(" and ")} in the sheet${images.length ? "" : " or a photo"}` : (product.error.issues[0]?.message ?? "invalid product"));
      }

      const productId = await upsertProduct(client, product.data, existing);
      report.outcome = existing ? "updated" : "created";
      touched.push(productId);
      await saveSizes(client, productId, row.variants);

      const { data: currentImages } = await client.from("product_images").select("storage_path, sort_order").eq("product_id", productId);
      const knownPaths = new Set((currentImages ?? []).map((image) => image.storage_path as string));
      let nextSort = Math.max(-1, ...(currentImages ?? []).map((image) => image.sort_order as number)) + 1;

      for (const [index, image] of images.entries()) {
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
        if (insertError) throw new Error(`photo row ${image.path} failed: ${insertError.message}`);
        knownPaths.add(storagePath);
        nextSort += 1;
        report.imagesAdded += 1;

        // The main photo was read already; others only with --suggest (their descriptions help meaning search).
        let reading = index === 0 ? mainPhoto : null;
        if (!reading && suggest) reading = await readPhoto(image).catch(() => null);
        if (reading) {
          await client
            .from("product_images")
            .update({
              extraction_status: "complete",
              ai_description: reading.suggestion.isProduct ? reading.suggestion.description : null,
              ai_attributes: toStoredSuggestion(reading.suggestion, reading.model),
            })
            .eq("id", inserted.id);
        }
      }

      if (publish) {
        const [{ count: imageCount }, { count: variantCount }] = await Promise.all([
          client.from("product_images").select("id", { count: "exact", head: true }).eq("product_id", productId),
          client.from("product_variants").select("id", { count: "exact", head: true }).eq("product_id", productId),
        ]);
        const status = existing?.status ?? "draft";
        const blockers = getPublishBlockers({ ...product.data, imageCount: imageCount ?? 0, variantCount: variantCount ?? 0 });
        if (status === "archived") report.message += "archived: left as it is; ";
        else if (blockers.length) report.message += `stays a draft: ${blockers.join(" ")} `;
        else if (status === "draft") {
          const { error } = await client.from("products").update({ status: "active" }).eq("id", productId);
          if (error) throw new Error(`publish failed: ${error.message}`);
          report.published = true;
        }
      }
      report.message = report.message.trim() || "ok";
    } catch (error) {
      report.message = error instanceof Error ? error.message : String(error);
      if (report.outcome !== "error") report.message = `partially imported: ${report.message}`;
    }
  }

  const reportPath = `${sheetPath}.report.json`;
  writeFileSync(reportPath, JSON.stringify({ sheet: sheetPath, dryRun, publish, suggest, finishedAt: new Date().toISOString(), rows: reports }, null, 2));

  for (const report of reports) {
    const ai = report.aiFilled.length ? `, AI: ${report.aiFilled.join(" ")}` : "";
    const live = report.published ? "  LIVE" : "";
    console.log(`line ${String(report.line).padStart(4)}  ${report.sku.padEnd(14)}  ${report.outcome.padEnd(12)}  ${report.photos} photo${report.photos === 1 ? "" : "s"} (+${report.imagesAdded}), ${report.sizes} sizes${ai}${live}  ${report.message}`);
  }
  const unused = photos.filter((photo) => !usedPhotos.has(resolve(baseDir, photo)));
  if (unused.length) console.log(`\nPhotos that matched no code (rename them like "<code>-1.jpg"): ${unused.slice(0, 20).join(", ")}${unused.length > 20 ? ` +${unused.length - 20} more` : ""}`);

  // Live products become findable by meaning and by photo straight away (drafts are indexed when published).
  if (!dryRun && touched.length && geminiKeys.length) {
    const text = await refreshProductEmbeddings(client, { apiKey: geminiKeys, model: env.GEMINI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL, productIds: touched }).catch(() => null);
    const pictures = await refreshProductImageEmbeddings(client, { apiKey: geminiKeys, model: env.GEMINI_IMAGE_EMBEDDING_MODEL || DEFAULT_IMAGE_EMBEDDING_MODEL, productIds: touched }).catch(() => null);
    const line = (label: string, result: { available: boolean; updated: number; failed: number } | null) =>
      !result ? `${label}: failed` : !result.available ? `${label}: off (migration not applied)` : `${label}: ${result.updated} updated${result.failed ? `, ${result.failed} failed` : ""}`;
    console.log(`\nSearch index: ${line("meaning", text)}; ${line("photos", pictures)}`);
  }

  const errors = reports.filter((report) => report.outcome === "error" || report.message.startsWith("partially")).length;
  const published = reports.filter((report) => report.published).length;
  console.log(`\n${reports.length - errors} ok${publish ? ` (${published} live)` : ""}, ${errors} with errors. Report: ${reportPath}`);
  process.exitCode = errors ? 2 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
