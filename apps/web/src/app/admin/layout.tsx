import { LogOut } from "lucide-react";
import Link from "next/link";
import { requireAdmin } from "@/auth/admin";
import { signOut } from "../login/actions";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const admin = await requireAdmin();

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <nav className="admin-nav" aria-label="Admin">
          <strong>Huzaifa Commerce Desk</strong>
          <Link href="/admin/products">Products</Link>
        </nav>
        <div className="admin-user">
          <span>{admin.email}</span>
          <form action={signOut}>
            <button type="submit" aria-label="Sign out"><LogOut size={16} /> Sign out</button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
