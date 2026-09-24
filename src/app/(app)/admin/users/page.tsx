import Link from "next/link";
import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import { PERMISSIONS, ROLE_NAMES, ROLES } from "@/modules/permissions/constants";
import { listUsers } from "@/modules/users/service";
import { createUserAction, setUserActiveAction } from "./actions";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const actor = await requireActor();
  const { error } = await searchParams;

  if (!actor.permissions.has(PERMISSIONS.USER_READ)) {
    return (
      <div>
        <div className="error-banner">
          You do not have permission to view this page (403).
        </div>
        <Link href="/patients">Back to patients</Link>
      </div>
    );
  }

  const users = await listUsers(getDb(), actor);
  const canManage = actor.permissions.has(PERMISSIONS.USER_MANAGE);

  return (
    <div>
      <h1>Users</h1>
      {error ? <div className="error-banner">{error}</div> : null}

      <table className="card">
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Roles</th>
            <th>Status</th>
            {canManage ? <th></th> : null}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>{u.displayName}</td>
              <td>{u.roleCodes.join(", ") || "—"}</td>
              <td>{u.isActive ? "Active" : "Inactive"}</td>
              {canManage ? (
                <td>
                  <form action={setUserActiveAction}>
                    <input type="hidden" name="userId" value={u.id} />
                    <input type="hidden" name="isActive" value={(!u.isActive).toString()} />
                    <button type="submit" className="secondary">
                      {u.isActive ? "Deactivate" : "Activate"}
                    </button>
                  </form>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>

      {canManage ? (
        <section className="card">
          <h2>Create user</h2>
          <form action={createUserAction}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required />
            </div>
            <div className="field">
              <label htmlFor="displayName">Display name</label>
              <input id="displayName" name="displayName" required />
            </div>
            <div className="field">
              <label htmlFor="password">Temporary password</label>
              <input id="password" name="password" type="password" required minLength={8} />
            </div>
            <div className="field">
              <label>Roles</label>
              {Object.values(ROLES).map((code) => (
                <label key={code} style={{ fontWeight: 400, display: "block" }}>
                  <input type="checkbox" name="roleCodes" value={code} /> {ROLE_NAMES[code]}
                </label>
              ))}
            </div>
            <button type="submit">Create user</button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
