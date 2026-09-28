import Link from "next/link";
import { getDb } from "@/db/client";
import { todayIn } from "@/lib/age";
import { getEnv } from "@/lib/env";
import { requireActor } from "@/modules/auth/current-actor";
import { inventorySummary } from "@/modules/inventory/catalog";
import type { DictKey } from "@/modules/inventory/i18n";
import { consumptionBetween } from "@/modules/inventory/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { fmtDate, fmtQty, inventoryLang } from "./_ui/lang";

/** Request time (kept out of the component body: rendering must stay pure). */
function requestTime(): number {
  return Date.now();
}

/** I3 overview: what needs attention now, and the latest movements. */
export default async function InventoryOverview() {
  const actor = await requireActor();
  const { lang, d } = await inventoryLang();
  const canManage = actor.permissions.has(PERMISSIONS.INVENTORY_MANAGE);
  const canSeePatients = actor.permissions.has(PERMISSIONS.PATIENT_READ);
  const db = getDb();
  const today = todayIn(getEnv().APP_TIME_ZONE);
  const s = await inventorySummary(db, actor, today);
  const now = requestTime();
  const usage = canManage ? await consumptionBetween(db, actor, new Date(now - 30 * 86_400_000), new Date(now + 60_000)) : [];
  const byDoctor = new Map<string, Map<string, number>>();
  for (const u of usage) {
    const m = byDoctor.get(u.doctorName ?? "—") ?? new Map<string, number>();
    const key = `${u.productName} (${u.unit})`;
    m.set(key, (m.get(key) ?? 0) + u.quantity);
    byDoctor.set(u.doctorName ?? "—", m);
  }
  const locale = lang === "ar" ? "ar-SA-u-nu-latn" : "en-GB";
  const when = (d0: Date) => d0.toLocaleString(locale, { dateStyle: "short", timeStyle: "short", timeZone: getEnv().APP_TIME_ZONE });

  return (
    <>
      <div className="inv-kpis">
        <Link className="inv-kpi" href="/inventory/stock">
          <span className="inv-kpi-n">{s.activeProducts}</span>
          <span>{d.kpiProducts}</span>
        </Link>
        <Link className={`inv-kpi${s.low.length ? " warn" : ""}`} href="/inventory/stock?show=low">
          <span className="inv-kpi-n" data-testid="kpi-low">{s.low.length}</span>
          <span>{d.kpiLow}</span>
        </Link>
        <Link className={`inv-kpi${s.expiring.length ? " warn" : ""}`} href="/inventory/stock?show=expiring">
          <span className="inv-kpi-n" data-testid="kpi-expiring">{s.expiring.length}</span>
          <span>{d.kpiExpiring}</span>
        </Link>
        <Link className={`inv-kpi${s.expiredCount ? " bad" : ""}`} href="/inventory/stock?show=expiring">
          <span className="inv-kpi-n">{s.expiredCount}</span>
          <span>{d.kpiExpired}</span>
        </Link>
      </div>

      {canManage ? (
        <div className="inv-actions" aria-label={d.quickActions}>
          <Link className="button" href="/inventory/receive">{d.navReceive}</Link>
          <Link className="button secondary" href="/inventory/stocktake">{d.navStocktake}</Link>
          <Link className="button secondary" href="/inventory/transfer">{d.navTransfer}</Link>
        </div>
      ) : null}

      <div className="inv-grid">
        <section className="card" aria-label={d.lowList}>
          <h3>{d.lowList}</h3>
          {s.low.length === 0 ? (
            <p className="muted">{d.nothingFound}</p>
          ) : (
            <table className="inv-table">
              <thead><tr><th>{d.product}</th><th>{d.inStock}</th><th>{d.minLevel}</th></tr></thead>
              <tbody>
                {s.low.slice(0, 10).map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td><span className={`inv-badge inv-q ${p.status}`}>{fmtQty(p.total)} {p.unit}</span></td>
                    <td>{p.minLevel === null ? d.none : `${fmtQty(p.minLevel)} ${p.unit}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="card" aria-label={d.expiringList}>
          <h3>{d.expiringList}</h3>
          {s.expiring.length === 0 ? (
            <p className="muted">{d.nothingFound}</p>
          ) : (
            <table className="inv-table">
              <thead><tr><th>{d.product}</th><th>{d.lot}</th><th>{d.expiry}</th><th>{d.quantity}</th></tr></thead>
              <tbody>
                {s.expiring.slice(0, 10).map((b) => (
                  <tr key={`${b.warehouseId}:${b.batchId}`} className={b.expiryDate !== null && b.expiryDate < today ? "inv-expired" : "inv-expiring"}>
                    <td>{b.productName}<div className="muted small">{b.warehouseName}</div></td>
                    <td>{b.lotNumber || d.none}</td>
                    <td>{fmtDate(b.expiryDate)}</td>
                    <td><span className="inv-q">{fmtQty(b.quantity)} {b.unit}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card" aria-label={d.recentMovements}>
        <h3>{d.recentMovements}</h3>
        {s.movements.length === 0 ? (
          <p className="muted">{d.noMovements}</p>
        ) : (
          <table className="inv-table">
            <thead><tr><th>{d.date}</th><th>{d.movement}</th><th>{d.product}</th><th>{d.quantity}</th><th>{d.store}</th><th>{d.by}</th></tr></thead>
            <tbody>
              {s.movements.map((m) => (
                <tr key={m.id}>
                  <td>{when(m.createdAt)}</td>
                  <td>{d[`mv_${m.movementType}` as DictKey] ?? m.movementType}</td>
                  <td>{m.productName}{m.lotNumber ? <span className="muted small"> · {m.lotNumber}</span> : null}</td>
                  <td className={m.quantity < 0 ? "inv-neg" : "inv-pos"} dir="ltr">{m.quantity > 0 ? "+" : ""}{fmtQty(m.quantity)} {m.unit}</td>
                  <td>{m.warehouseName}</td>
                  <td>{m.createdBy ?? d.none}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canManage ? (
        <section className="card" aria-label="Materials used by doctor">
          <h3>{d.usageByDoctor}</h3>
          <p><Link href="/inventory/consumption">{d.fullReport}</Link></p>
          {byDoctor.size === 0 ? (
            <p className="muted">{d.nothingRecorded}</p>
          ) : (
            [...byDoctor.entries()].map(([doctor, items]) => (
              <div key={doctor}>
                <strong>{doctor}</strong>
                <ul>
                  {[...items.entries()].map(([k, q]) => <li key={k}>{k}: {fmtQty(q)}</li>)}
                </ul>
              </div>
            ))
          )}
          {usage.length > 0 && canSeePatients ? (
            <details>
              <summary>{d.byPatient} ({usage.length})</summary>
              <table className="inv-table">
                <thead><tr><th>{d.date}</th><th>{d.patient}</th><th>{d.doctor}</th><th>{d.product}</th><th>{d.quantity}</th><th>{d.recordedBy}</th></tr></thead>
                <tbody>
                  {usage.map((u) => (
                    <tr key={u.id}>
                      <td>{when(u.createdAt)}</td>
                      <td>{u.patientName}</td>
                      <td>{u.doctorName ?? d.none}</td>
                      <td>{u.productName} ({d.lot} {u.lotNumber || d.none})</td>
                      <td><span className="inv-q">{fmtQty(u.quantity)} {u.unit}</span></td>
                      <td>{u.recordedBy ?? d.none}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
