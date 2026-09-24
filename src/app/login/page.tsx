import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/auth/current-actor";
import { loginAction } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const actor = await getCurrentActor();
  if (actor) {
    redirect("/patients");
  }

  const { error } = await searchParams;

  return (
    <div className="container" style={{ maxWidth: 420, marginTop: "4rem" }}>
      <h1>Dawali Medical System</h1>
      <p>Sign in to continue.</p>
      {error ? <div className="error-banner">{error}</div> : null}
      <form action={loginAction} className="card">
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
