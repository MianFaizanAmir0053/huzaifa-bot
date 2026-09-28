import type { Language } from "@huzaifa/contracts";
import type { CatalogProduct } from "@/catalog/types";

const pkr = new Intl.NumberFormat("en-PK", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 0,
});

export function renderGreeting(language: Language): string {
  if (language === "ur") return "السلام علیکم! آپ کس قسم کی پروڈکٹ تلاش کر رہے ہیں؟";
  if (language === "roman_ur") return "Assalam-o-alaikum! Aap kis qisam ki product dhoond rahe hain?";
  return "Hello! What kind of product are you looking for?";
}

export function renderNoMatch(language: Language): string {
  if (language === "ur") return "مجھے اس تفصیل سے کوئی یقینی پروڈکٹ نہیں ملی۔ نام، رنگ یا تصویر بھیج دیں۔";
  if (language === "roman_ur") return "Mujhe is tafseel se koi yaqini product nahi mili. Naam, rang ya tasveer bhej dein.";
  return "I couldn't find a confident match. Please send a product name, color, or photo.";
}

export function renderHandoff(language: Language): string {
  if (language === "ur") return "میں نے ہماری ٹیم کو اطلاع دے دی ہے۔ اب ایک شخص اسی چیٹ میں آپ کی مدد کرے گا۔";
  if (language === "roman_ur") return "Maine hamari team ko bata diya hai. Ab ek person isi chat mein aap ki madad karega.";
  return "I've notified our team. A person will continue helping you in this chat.";
}

export function renderProduct(product: CatalogProduct, language: Language, requestedSize?: string): string {
  const price = pkr.format(product.pricePkr);
  const normalizedRequestedSize = requestedSize?.trim().toLowerCase();
  const requestedVariant = normalizedRequestedSize
    ? product.variants.find((variant) => variant.normalizedSize === normalizedRequestedSize)
    : undefined;

  if (requestedSize) {
    const available = requestedVariant && requestedVariant.stockQty > 0;
    if (language === "ur") {
      return `${product.name}\nقیمت: ${price}\nسائز ${requestedSize}: ${available ? "دستیاب" : "دستیاب نہیں"}`;
    }
    if (language === "roman_ur") {
      return `${product.name}\nQeemat: ${price}\nSize ${requestedSize}: ${available ? "available hai" : "available nahi hai"}`;
    }
    return `${product.name}\nPrice: ${price}\nSize ${requestedSize}: ${available ? "in stock" : "not in stock"}`;
  }

  const availableSizes = product.variants.filter((variant) => variant.stockQty > 0).map((variant) => variant.size);
  const sizes = availableSizes.length > 0 ? availableSizes.join(", ") : null;
  if (language === "ur") {
    return `${product.name}\nقیمت: ${price}\n${sizes ? `دستیاب سائز: ${sizes}` : "فی الحال اسٹاک میں نہیں"}`;
  }
  if (language === "roman_ur") {
    return `${product.name}\nQeemat: ${price}\n${sizes ? `Available sizes: ${sizes}` : "Filhal stock mein nahi hai"}`;
  }
  return `${product.name}\nPrice: ${price}\n${sizes ? `Available sizes: ${sizes}` : "Currently out of stock"}`;
}