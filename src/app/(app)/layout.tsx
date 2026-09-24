import Link from "next/link";
import { requireActor } from "@/modules/auth/current-actor";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { logoutAction } from "./logout-action";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const actor = await requireActor();
  const canSeeAdmin = actor.permissions.has(PERMISSIONS.USER_READ);
  const canManageOptions = actor.permissions.has(PERMISSIONS.CLINICAL_OPTION_MANAGE);

  return (
    <>
      <header className="top-nav">
        <div className="links">
          <Link href="/patients">Patients</Link>
          {canSeeAdmin ? <Link href="/admin/users">Admin: Users</Link> : null}
          {canManageOptions ? <Link href="/admin/options">Admin: Options</Link> : null}
        </div>
        <div className="links">
          <span className="badge">{actor.displayName}</span>
          <form action={logoutAction}>
            <button type="submit" className="secondary">
              Logout
            </button>
          </form>
        </div>
      </header>
      <main className="container">{children}</main>
    </>
  );
}
