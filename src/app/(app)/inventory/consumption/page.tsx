import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { todayIn } from "@/lib/age";
import { isoToDayMonthYear, parseDateInput } from "@/lib/day-month-year";
import { getEnv } from "@/lib/env";
import { requireActor } from "@/modules/auth/current-actor";
import { ConsumptionFilterError, consumptionReport, type ConsumptionFilter } from "@/modules/inventory/consumption-report";
import { listDoctors, listWarehouses } from "@/modules/inventory/service";
import { PERMISSIONS } from "@/modules/permissions/constants";

const sar = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const UUID = /^[0-9a-f-]{36}$/i;

/** I2 (ADR-037): materials used by doctor, product and patient over a period, with cost. */
export default async function ConsumptionPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; doctor?: string; store?: string }>;
}) {
  const actor = await requireActor();
  if (!actor.permissions.has(PERMISSIONS.INVENTORY_MANAGE)) notFound();
  const db = getDb();
  const timeZone = getEnv().APP_TIME_ZONE;
  const today = todayIn(timeZone);
  const q = await searchParams;
  // Typed day/month/year in the form; yyyy-mm-dd in links. A wrong date is reported, not guessed.
  const from = parseDateInput(q.from ?? "") || `${today.slice(0, 8)}01`;
  const to = parseDateInput(q.to ?? "") || today;
  const badDate = [q.from, q.to].some((v) => v !== undefined && parseDateInput(v) === null);
  const filter: ConsumptionFilter = {
    from,
    to,
    doctorId: q.doctor && UUID.test(q.doctor) ? q.doctor : undefined,
    warehouseId: q.store && UUID.test(q.store) ? q.store : undefined,
  };
  const [doctors, warehouses] = await Promise.all([listDoctors(db), listWarehouses(db, actor)]);
  let report = null;
  let error: string | null = badDate ? "Write dates as day/month/year, e.g. 31/12/2027." : null;
  if (!badDate) {
    try {
      report = await consumptionReport(db, actor, filter, timeZone);
    } catch (err) {
      if (!(err instanceof ConsumptionFilterError)) throw err;
      error = err.message;
    }
  }
  const exportParams = new URLSearchParams({ from: filter.from, to: filter.to });
  if (filter.doctorId) exportParams.set("doctor", filter.doctorId);
  if (filter.warehouseId) exportParams.set("store", filter.warehouseId);

  return (
    <div className="inventory">
      <p><a href="/inventory">← Inventory</a></p>
      <h1>Materials used</h1>
      <form method="get" className="card inv-filter" aria-label="Report filter">
        <label>From <input name="from" dir="ltr" inputMode="numeric" placeholder="dd/mm/yyyy" size={10} defaultValue={badDate ? q.from : isoToDayMonthYear(filter.from)} required /></label>
        <label>To <input name="to" dir="ltr" inputMode="numeric" placeholder="dd/mm/yyyy" size={10} defaultValue={badDate ? q.to : isoToDayMonthYear(filter.to)} required /></label>
        <label>
          Doctor{" "}
          <select name="doctor" defaultValue={filter.doctorId ?? ""}>
            <option value="">All doctors</option>
            {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label>
          Store{" "}
          <select name="store" defaultValue={filter.warehouseId ?? ""}>
            <option value="">All stores</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <button type="submit">Show</button>
        {report ? (
          <a className="button secondary" href={`/api/inventory/consumption?${exportParams.toString()}`} download>
            Export to Excel
          </a>
        ) : null}
      </form>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {report ? (
        <>
          <section className="card" aria-label="Totals">
            <p data-testid="consumption-total">
              <strong>Total cost: {sar(report.totalCost)} SAR</strong> (excl. VAT) — {report.lines.length} entries
              {report.unpriced > 0 ? `, ${report.unpriced} without an invoice price (not in the cost)` : ""}
            </p>
          </section>
          <section className="card" aria-label="Cost per procedure">
            <h3>Cost per procedure</h3>
            <p className="muted">
              A procedure is one visit: every material recorded on it, named by the kit used (items added on top of the kit included).
            </p>
            {report.byProcedure.length === 0 ? <p className="muted">Nothing recorded in this period.</p> : (
              <table className="inv-table">
                <thead>
                  <tr><th>Procedure (kit)</th><th>Doctor</th><th>Procedures</th><th>Average</th><th>Lowest – highest</th><th>Total</th></tr>
                </thead>
                <tbody>
                  {report.byProcedure.flatMap((p) => [
                    <tr key={p.procedure} className="inv-proc-total">
                      <td>{p.procedure}</td><td>All doctors</td><td>{p.visits}</td>
                      <td>{sar(p.average)}{p.incomplete ? " *" : ""}</td>
                      <td>{sar(p.min)} – {sar(p.max)}</td><td>{sar(p.cost)}</td>
                    </tr>,
                    ...(p.byDoctor.length > 1
                      ? p.byDoctor.map((d) => (
                          <tr key={`${p.procedure}:${d.doctor}`}>
                            <td /><td>{d.doctor}</td><td>{d.visits}</td><td>{sar(d.average)}</td><td /><td>{sar(d.cost)}</td>
                          </tr>
                        ))
                      : []),
                  ])}
                </tbody>
              </table>
            )}
            {report.byProcedure.some((p) => p.incomplete > 0) ? (
              <p className="muted">* some of these procedures have lines without an invoice price, so their cost is too low.</p>
            ) : null}
          </section>
          <section className="card" aria-label="By visit">
            <h3>By visit</h3>
            <table className="inv-table">
              <thead>
                <tr><th>Date</th>{report.canSeePatients ? <th>Patient</th> : null}<th>Doctor</th><th>Procedure (kit)</th><th>Lines</th><th>Cost</th></tr>
              </thead>
              <tbody>
                {report.byVisit.map((v) => (
                  <tr key={v.visitId}>
                    <td>{v.date.toLocaleDateString("en-GB", { timeZone })}</td>
                    {report.canSeePatients ? <td>{v.patientName}</td> : null}
                    <td>{v.doctors}</td><td>{v.procedure}</td><td>{v.items}</td>
                    <td>{sar(v.cost)}{v.unpriced ? " *" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="card" aria-label="By doctor">
            <h3>By doctor</h3>
            {report.byDoctor.length === 0 ? <p className="muted">Nothing recorded in this period.</p> : null}
            {report.byDoctor.map((d) => (
              <table key={d.doctor} className="inv-table" aria-label={`Doctor ${d.doctor}`}>
                <thead>
                  <tr><th colSpan={3}>{d.doctor}</th><th>{sar(d.cost)} SAR</th></tr>
                  <tr><th>Product</th><th>Quantity</th><th>Unit</th><th>Cost</th></tr>
                </thead>
                <tbody>
                  {d.products.map((p) => (
                    <tr key={p.key}>
                      <td>{p.label}</td><td>{p.quantity}</td><td>{p.unit}</td>
                      <td>{sar(p.cost)}{p.unpriced ? " *" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </section>
          <section className="card" aria-label="By product">
            <h3>By product</h3>
            <table className="inv-table">
              <thead><tr><th>Product</th><th>Quantity</th><th>Unit</th><th>Cost</th></tr></thead>
              <tbody>
                {report.byProduct.map((p) => (
                  <tr key={p.key}>
                    <td>{p.label}</td><td>{p.quantity}</td><td>{p.unit}</td>
                    <td>{sar(p.cost)}{p.unpriced ? " *" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">* some entries have no invoice price and are not in the cost.</p>
          </section>
          <section className="card" aria-label="Details">
            <h3>Details</h3>
            <table className="inv-table">
              <thead>
                <tr>
                  <th>Date</th>{report.canSeePatients ? <th>Patient</th> : null}<th>Doctor</th><th>Product</th>
                  <th>Store</th><th>Qty</th><th>Cost</th><th>Recorded by</th>
                </tr>
              </thead>
              <tbody>
                {report.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.createdAt.toLocaleDateString("en-GB", { timeZone })}</td>
                    {report.canSeePatients ? <td>{l.patientName}</td> : null}
                    <td>{l.doctorName}</td>
                    <td>{l.productName} (lot {l.lotNumber || "—"})</td>
                    <td>{l.warehouseName}</td>
                    <td>{l.quantity} {l.unit}</td>
                    <td>{l.lineCost === null ? "—" : sar(l.lineCost)}</td>
                    <td>{l.recordedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
    </div>
  );
}
