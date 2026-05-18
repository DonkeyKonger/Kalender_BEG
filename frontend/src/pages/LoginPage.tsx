import { FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../lib/api";

type LocationState = {
  from?: { pathname?: string };
};

export function LoginPage() {
  const { login, status, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (status === "authenticated" && user) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await login(username.trim(), password);
      const state = location.state as LocationState | null;
      navigate(state?.from?.pathname ?? "/", { replace: true });
    } catch (requestError) {
      if (requestError instanceof ApiError) {
        setError(
          typeof requestError.detail === "string"
            ? requestError.detail
            : requestError.message,
        );
      } else {
        setError("Anmeldung aktuell nicht moeglich.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="login-screen">
      <section className="login-panel" aria-labelledby="login-heading">
        <div className="login-heading-block">
          <span className="brand-mark large">KB</span>
          <div>
            <h1 id="login-heading">Kalender Baustellen</h1>
            <p>Interne Einsatzplanung</p>
          </div>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            <span>Anmeldename</span>
            <input
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>

          <label>
            <span>Passwort</span>
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {error && <p className="form-error">{error}</p>}

          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Anmeldung laeuft..." : "Anmelden"}
          </button>
        </form>
      </section>
    </main>
  );
}
