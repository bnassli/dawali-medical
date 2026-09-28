import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import { listCatalog } from "@/modules/inventory/catalog";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { inventoryLang } from "../_ui/lang";
import { ProductsEditor } from "./products-editor";

/** I3: the product catalogue — unit, category, minimum level, barcode. */
export default async function ProductsPage() {
  const actor = await requireActor();
  const { d } = await inventoryLang();
  const products = await listCatalog(getDb(), actor);
  return (
    <section className="card" aria-label={d.products}>
      <p className="muted">{d.productsHint}</p>
      <ProductsEditor d={d} products={products} canManage={actor.permissions.has(PERMISSIONS.INVENTORY_MANAGE)} />
    </section>
  );
}
