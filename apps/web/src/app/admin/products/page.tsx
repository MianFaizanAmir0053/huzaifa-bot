import { ImageOff, Plus } from "lucide-react";
import Link from "next/link";
import { requireAdmin } from "@/auth/admin";
import { PRODUCT_STATUSES, listAdminProducts, type ProductStatus } from "@/catalog/admin/queries";

const pkr = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const status = PRODUCT_STATUSES.includes(params.status as ProductStatus) ? (params.status as ProductStatus) : undefined;
  const products = await listAdminProducts({ query, status });

  return (
    <main className="admin-main">
      <div className="page-head">
        <h1>Products</h1>
        <Link className="button-link" href="/admin/products/new"><Plus size={16} /> New product</Link>
      </div>

      <form className="filter-bar" role="search">
        <input name="q" defaultValue={query} placeholder="Search name, SKU or category" aria-label="Search products" />
        <select name="status" defaultValue={status ?? ""} aria-label="Status">
          <option value="">All statuses</option>
          {PRODUCT_STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <button type="submit" className="secondary">Filter</button>
      </form>

      {products.length === 0 ? (
        <p className="empty-state">{query || status ? "No products match these filters." : "No products yet. Create the first one."}</p>
      ) : (
        <ul className="product-list">
          {products.map((product) => (
            <li key={product.id}>
              <Link href={`/admin/products/${product.id}`} className="product-row">
                {product.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- public Supabase URL, no optimizer needed for thumbnails
                  <img src={product.thumbnailUrl} alt="" width={56} height={56} loading="lazy" />
                ) : (
                  <span className="thumb-placeholder" aria-hidden="true"><ImageOff size={18} /></span>
                )}
                <span className="product-row-main">
                  <strong>{product.name}</strong>
                  <span className="muted">{product.sku} · {product.category}</span>
                </span>
                <span className="product-row-meta">
                  <span>{pkr.format(product.pricePkr)}</span>
                  <span className="muted">{product.sizesInStock}/{product.sizeCount} sizes in stock</span>
                </span>
                <span className={`status-badge ${product.status}`}>{product.status}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
