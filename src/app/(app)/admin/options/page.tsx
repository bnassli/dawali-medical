import Link from "next/link";
import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import { listOptionListsForAdmin } from "@/modules/clinical/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { setOptionActiveAction } from "./actions";

export default async function AdminOptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const actor = await requireActor();
  const { error } = await searchParams;

  if (!actor.permissions.has(PERMISSIONS.CLINICAL_OPTION_MANAGE)) {
    return (
      <div>
        <div className="error-banner">
          You do not have permission to view this page (403).
        </div>
        <Link href="/patients">Back to patients</Link>
      </div>
    );
  }

  const lists = await listOptionListsForAdmin(getDb(), actor);

  return (
    <div>
      <h1>Clinical option lists</h1>
      <p className="muted">
        New options are added from the clinical tab with &quot;+ Add New&quot;. Options are never
        renamed or deleted; retiring one hides it from new selections while existing visits keep
        showing it.
      </p>
      {error ? <div className="error-banner">{error}</div> : null}

      {lists.map((list) => (
        <section key={list.id} className="card">
          <h2 style={{ marginTop: 0 }}>{list.name}</h2>
          {list.options.length === 0 ? (
            <p className="muted">No options yet.</p>
          ) : (
            <table>
              <tbody>
                {list.options.map((o) => (
                  <tr key={o.id}>
                    <td>{o.label}</td>
                    <td>{o.isActive ? "Active" : "Retired"}</td>
                    <td>
                      <form action={setOptionActiveAction}>
                        <input type="hidden" name="optionId" value={o.id} />
                        <input type="hidden" name="isActive" value={(!o.isActive).toString()} />
                        <button type="submit" className="secondary">
                          {o.isActive ? "Retire" : "Reactivate"}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}
