import { getDb } from "@/db/client";
import { todayIn } from "@/lib/age";
import { getEnv } from "@/lib/env";
import { requireActor } from "@/modules/auth/current-actor";
import { addDays, EXPIRY_WARNING_DAYS, stockOverview, type StockFilter } from "@/modules/inventory/catalog";
import { listWarehouses } from "@/modules/inventory/service";
import { fmtDate, fmtQty, inventoryLang } from "../_ui/lang";

const FILTERS: StockFilter[] = ["all", "low", "expiring", "out"];

/** I3: stock per product — in one store or all — with status, expiry and batches. */
export default async function StockPage({ searchParams }: { searchParams: Promise<{ store?: string; q?: string; show?: string }> }) {
  const actor = await requireActor();
  const { d } = await inventoryLang();
  const db = getDb();
  const today = todayIn(getEnv().APP_TIME_ZONE);
  const soon = addDays(today, EXPIRY_WARNING_DAYS);
  const sp = await searchParams;
  const stores = await listWarehouses(db, actor);
  const store = sp.store === "all" ? undefined : (stores.find((w) => w.id === sp.store) ?? stores[0]);
  const filter = FILTERS.includes(sp.show as StockFilter) ? (sp.show as StockFilter) : "all";
  const rows = await stockOverview(db, actor, { warehouseId: store?.id, q: sp.q, filter, today });
  const storeName = new Map(stores.map((w) => [w.id, w.name]));
  const statusLabel = { out: d.out, low: d.low, ok: d.ok } as const;

  return (
    <section className="card" aria-label="Stock">
      <form className="inv-row inv-filters" method="get">
        <label>
          {d.store}{" "}
          <select name="store" defaultValue={store?.id ?? "all"}>
            {stores.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            <option value="all">{d.allStores}</option>
          </select>
        </label>
        <label>
          {d.search}{" "}
          <input type="search" name="q" defaultValue={sp.q ?? ""} placeholder={d.searchPlaceholder} />
        </label>
        <label>
          {d.filter}{" "}
          <select name="show" defaultValue={filter}>
            <option value="all">{d.filterAll}</option>
            <option value="low">{d.filterLow}</option>
            <option value="expiring">{d.filterExpiring}</option>
            <option value="out">{d.filterOut}</option>
          </select>
        </label>
        <button type="submit">{d.apply}</button>
      </form>
      {rows.length === 0 ? (
        <p className="muted">{sp.q || filter !== "all" ? d.nothingFound : d.noStock}</p>
      ) : (
        <table className="inv-table">
          <thead>
            <tr>
              <th>{d.product}</th>
              <th>{store ? store.name : d.allStores}</th>
              {store ? <th>{d.totalAllStores}</th> : null}
              <th>{d.minLevel}</th>
              <th>{d.status}</th>
              <th>{d.nearestExpiry}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const expired = p.nearestExpiry !== null && p.nearestExpiry < today;
              const expiring = !expired && p.nearestExpiry !== null && p.nearestExpiry <= soon;
              return (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.category ? <span className="muted small"> · {p.category}</span> : null}
                    {p.batches.length > 0 ? (
                      <details className="inv-batches">
                        <summary>{d.batches} ({p.batches.length})</summary>
                        <ul>
                          {p.batches.map((b) => (
                            <li key={`${b.warehouseId}:${b.batchId}`}>
                              {d.lot} {b.lotNumber || d.none} · {d.expiry} {fmtDate(b.expiryDate)} · <span className="inv-q">{fmtQty(b.quantity)} {p.unit}</span>
                              {store ? null : <span className="muted"> · {storeName.get(b.warehouseId)}</span>}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </td>
                  <td><span className="inv-q">{fmtQty(p.quantity)} {p.unit}</span></td>
                  {store ? <td><span className="inv-q">{fmtQty(p.total)} {p.unit}</span></td> : null}
                  <td>{p.minLevel === null ? d.none : `${fmtQty(p.minLevel)} ${p.unit}`}</td>
                  <td><span className={`inv-badge ${p.status}`}>{statusLabel[p.status]}</span></td>
                  <td className={expired ? "inv-expired" : expiring ? "inv-expiring" : undefined}>
                    {fmtDate(p.nearestExpiry)}
                    {expired ? ` (${d.expired})` : expiring ? ` (${d.expiringSoon})` : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
