import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import { countSheet } from "@/modules/inventory/catalog";
import { listWarehouses } from "@/modules/inventory/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { inventoryLang } from "../_ui/lang";
import { StocktakeForm } from "./stocktake-form";

/** I3: stock count per store; the first count is the opening balance. */
export default async function StocktakePage({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const actor = await requireActor();
  if (!actor.permissions.has(PERMISSIONS.INVENTORY_MANAGE)) notFound();
  const { d } = await inventoryLang();
  const db = getDb();
  const stores = await listWarehouses(db, actor);
  const { store: storeId } = await searchParams;
  const store = stores.find((w) => w.id === storeId) ?? stores[0];
  if (!store) notFound();
  const sheet = await countSheet(db, actor, store.id);
  return (
    <section className="card" aria-label={d.stocktakeTitle}>
      <form className="inv-row" method="get">
        <label>
          {d.store}{" "}
          <select name="store" defaultValue={store.id}>
            {stores.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <button type="submit" className="secondary">{d.apply}</button>
      </form>
      <p className="muted">{d.stocktakeHint}</p>
      <StocktakeForm key={store.id} d={d} warehouseId={store.id} sheet={sheet} />
    </section>
  );
}
