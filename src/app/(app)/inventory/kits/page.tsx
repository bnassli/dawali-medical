import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import { listCatalog } from "@/modules/inventory/catalog";
import { listKits } from "@/modules/inventory/kits";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { inventoryLang } from "../_ui/lang";
import { KitsEditor } from "./kits-editor";

/** I4 (ADR-042): procedure kits — the usual materials of a procedure, recorded on the visit in one step. */
export default async function KitsPage() {
  const actor = await requireActor();
  const { d } = await inventoryLang();
  const [kits, catalog] = await Promise.all([listKits(getDb(), actor), listCatalog(getDb(), actor)]);
  return (
    <section className="card" aria-label={d.navKits}>
      <p className="muted">{d.kitsHint}</p>
      <KitsEditor
        d={d}
        kits={kits}
        products={catalog.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.name, unit: p.unit }))}
        canManage={actor.permissions.has(PERMISSIONS.INVENTORY_MANAGE)}
      />
    </section>
  );
}
