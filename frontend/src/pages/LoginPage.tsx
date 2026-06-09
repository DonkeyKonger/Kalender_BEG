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
    return <Navigate to={user.must_change_password ? "/change-password" : "/"} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const loggedInUser = await login(username.trim(), password);
      if (loggedInUser.must_change_password) {
        navigate("/change-password", { replace: true });
        return;
      }
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

export function PasswordChangePage() {
  const { changePassword, logout, status, user } = useAuth();
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (status === "loading") {
    return <div className="screen-state">Wird geladen...</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!user.must_change_password) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("Die Passwoerter stimmen nicht ueberein.");
      return;
    }

    setIsSubmitting(true);
    try {
      await changePassword(newPassword);
      navigate("/", { replace: true });
    } catch (requestError) {
      if (requestError instanceof ApiError) {
        setError(
          typeof requestError.detail === "string"
            ? requestError.detail
            : requestError.message,
        );
      } else {
        setError("Passwort konnte aktuell nicht gespeichert werden.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="login-screen">
      <section className="login-panel" aria-labelledby="password-change-heading">
        <div className="login-heading-block">
          <span className="brand-mark large">KB</span>
          <div>
            <h1 id="password-change-heading">Neues Passwort festlegen</h1>
            <p>Bitte ersetze das Startpasswort durch dein eigenes Passwort.</p>
          </div>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            <span>Neues Passwort</span>
            <input
              autoComplete="new-password"
              autoFocus
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>

          <label>
            <span>Passwort bestaetigen</span>
            <input
              autoComplete="new-password"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>

          {error && <p className="form-error">{error}</p>}

          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Wird gespeichert..." : "Passwort speichern"}
          </button>
          <button type="button" disabled={isSubmitting} onClick={() => void logout()}>
            Abmelden
          </button>
        </form>
      </section>
    </main>
  );
}
