export type ProductVariant = {
  size: string;
  normalizedSize: string;
  stockQty: number;
};

export type CatalogProduct = {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  color: string | null;
  material: string | null;
  pricePkr: number;
  similarityScore: number;
  variants: ProductVariant[];
};