import { redirect } from "next/navigation";
import { requireAdmin } from "@/auth/admin";

export default async function AdminHome() {
  await requireAdmin();
  redirect("/admin/products");
}
