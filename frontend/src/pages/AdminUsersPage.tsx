import { KeyRound, Save, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../lib/api";
import type { UserRole } from "../types/auth";
import type { Person } from "../types/person";
import type { AdminUser, AdminUserCreate, AdminUserUpdate } from "../types/user";

const roleLabels: Record<UserRole, string> = {
  admin: "Admin",
  project_manager: "Projektleiter",
  office: "Buero",
  monteur: "Monteur",
};

type EditableUser = {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  person_id: number | null;
  reset_password: string;
};

const emptyCreateForm: AdminUserCreate = {
  username: "",
  display_name: "",
  password: "",
  role: "monteur",
  is_active: true,
  person_id: null,
};

export function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [drafts, setDrafts] = useState<Record<string, EditableUser>>({});
  const [people, setPeople] = useState<Person[]>([]);
  const [createForm, setCreateForm] = useState<AdminUserCreate>(emptyCreateForm);
  const [isLoading, setIsLoading] = useState(true);
  const [savingUserId, setSavingUserId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void loadData();
  }, []);

  async function loadData() {
    setIsLoading(true);
    setError(null);
    try {
      const [userData, personData] = await Promise.all([api.users(), api.persons({ isActive: null })]);
      setUsers(userData);
      setDrafts(toEditableUsers(userData));
      setPeople(personData);
    } catch (requestError) {
      setError(readApiError(requestError, "Benutzer konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }

  const peopleById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);

  async function createUser() {
    setSavingUserId(0);
    setError(null);
    setMessage(null);
    try {
      const created = await api.createUser({
        ...createForm,
        username: createForm.username.trim(),
        display_name: createForm.display_name.trim(),
      });
      setUsers((current) => [...current, created].sort((left, right) => left.username.localeCompare(right.username)));
      setDrafts((current) => ({ ...current, [created.id]: toEditableUser(created) }));
      setCreateForm(emptyCreateForm);
      setMessage("Benutzer angelegt.");
    } catch (requestError) {
      setError(readApiError(requestError, "Benutzer konnte nicht angelegt werden."));
    } finally {
      setSavingUserId(null);
    }
  }

  async function saveUser(userId: number) {
    const draft = drafts[userId];
    if (!draft) {
      return;
    }
    setSavingUserId(userId);
    setError(null);
    setMessage(null);
    try {
      const payload: AdminUserUpdate = {
        username: draft.username.trim(),
        display_name: draft.display_name.trim(),
        role: draft.role,
        is_active: draft.is_active,
        person_id: draft.person_id,
      };
      const updated = await api.updateUser(userId, payload);
      replaceUser(updated);
      setMessage("Benutzer gespeichert.");
    } catch (requestError) {
      setError(readApiError(requestError, "Benutzer konnte nicht gespeichert werden."));
    } finally {
      setSavingUserId(null);
    }
  }

  async function resetPassword(userId: number) {
    const draft = drafts[userId];
    if (!draft?.reset_password) {
      setError("Bitte ein neues Passwort eintragen.");
      return;
    }
    setSavingUserId(userId);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.resetUserPassword(userId, draft.reset_password);
      replaceUser(updated);
      setDrafts((current) => ({
        ...current,
        [userId]: { ...toEditableUser(updated), reset_password: "" },
      }));
      setMessage("Passwort gesetzt.");
    } catch (requestError) {
      setError(readApiError(requestError, "Passwort konnte nicht gesetzt werden."));
    } finally {
      setSavingUserId(null);
    }
  }

  async function disableUser(userId: number) {
    setSavingUserId(userId);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.disableUser(userId);
      replaceUser(updated);
      setMessage("Benutzer deaktiviert.");
    } catch (requestError) {
      setError(readApiError(requestError, "Benutzer konnte nicht deaktiviert werden."));
    } finally {
      setSavingUserId(null);
    }
  }

  function replaceUser(updated: AdminUser) {
    setUsers((current) => current.map((user) => user.id === updated.id ? updated : user));
    setDrafts((current) => ({ ...current, [updated.id]: toEditableUser(updated) }));
  }

  function updateDraft(userId: number, values: Partial<EditableUser>) {
    setDrafts((current) => ({
      ...current,
      [userId]: { ...current[userId], ...values },
    }));
  }

  return (
    <section className="admin-users-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Benutzer</h1>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}
      {message && <p className="form-info">{message}</p>}

      <section className="admin-create-panel">
        <h2><UserPlus aria-hidden="true" size={18} />Neuer Benutzer</h2>
        <div className="admin-form-grid">
          <label>
            <span>Anmeldename</span>
            <input value={createForm.username} onChange={(event) => setCreateForm({ ...createForm, username: event.target.value })} />
          </label>
          <label>
            <span>Anzeigename</span>
            <input value={createForm.display_name} onChange={(event) => setCreateForm({ ...createForm, display_name: event.target.value })} />
          </label>
          <label>
            <span>Startpasswort</span>
            <input type="password" value={createForm.password} onChange={(event) => setCreateForm({ ...createForm, password: event.target.value })} />
          </label>
          <label>
            <span>Rolle</span>
            <select value={createForm.role} onChange={(event) => setCreateForm({ ...createForm, role: event.target.value as UserRole })}>
              {roleOptions()}
            </select>
          </label>
          <label>
            <span>Person</span>
            <select value={createForm.person_id ?? ""} onChange={(event) => setCreateForm({ ...createForm, person_id: parsePersonId(event.target.value) })}>
              <option value="">Keine Zuordnung</option>
              {personOptions(people)}
            </select>
          </label>
          <label className="checkbox-field">
            <input checked={createForm.is_active} type="checkbox" onChange={(event) => setCreateForm({ ...createForm, is_active: event.target.checked })} />
            <span>Aktiv</span>
          </label>
        </div>
        <button className="icon-button" disabled={savingUserId === 0} type="button" onClick={() => void createUser()}>
          <UserPlus aria-hidden="true" size={17} />
          <span>Benutzer anlegen</span>
        </button>
      </section>

      {isLoading && <div className="matrix-state">Benutzer werden geladen...</div>}

      {!isLoading && (
        <div className="admin-user-list">
          {users.map((user) => {
            const draft = drafts[user.id] ?? toEditableUser(user);
            const linkedPerson = user.person_id ? peopleById.get(user.person_id) : null;
            return (
              <article className="admin-user-row" key={user.id}>
                <div className="admin-user-meta">
                  <strong>{user.username}</strong>
                  <span>{linkedPerson?.display_name ?? "Keine Person"}</span>
                  <span className={user.is_active ? "active-text" : "inactive-text"}>{user.is_active ? "Aktiv" : "Deaktiviert"}</span>
                </div>

                <div className="admin-form-grid compact">
                  <label>
                    <span>Anmeldename</span>
                    <input value={draft.username} onChange={(event) => updateDraft(user.id, { username: event.target.value })} />
                  </label>
                  <label>
                    <span>Anzeigename</span>
                    <input value={draft.display_name} onChange={(event) => updateDraft(user.id, { display_name: event.target.value })} />
                  </label>
                  <label>
                    <span>Rolle</span>
                    <select value={draft.role} onChange={(event) => updateDraft(user.id, { role: event.target.value as UserRole })}>
                      {roleOptions()}
                    </select>
                  </label>
                  <label>
                    <span>Person</span>
                    <select value={draft.person_id ?? ""} onChange={(event) => updateDraft(user.id, { person_id: parsePersonId(event.target.value) })}>
                      <option value="">Keine Zuordnung</option>
                      {personOptions(people)}
                    </select>
                  </label>
                  <label className="checkbox-field">
                    <input checked={draft.is_active} type="checkbox" onChange={(event) => updateDraft(user.id, { is_active: event.target.checked })} />
                    <span>Aktiv</span>
                  </label>
                </div>

                <div className="admin-user-actions">
                  <button className="icon-button secondary" disabled={savingUserId === user.id} type="button" onClick={() => void saveUser(user.id)}>
                    <Save aria-hidden="true" size={16} />
                    <span>Speichern</span>
                  </button>
                  <button className="icon-button secondary" disabled={savingUserId === user.id || !draft.is_active} type="button" onClick={() => void disableUser(user.id)}>
                    <span>Deaktivieren</span>
                  </button>
                </div>

                <div className="password-reset-row">
                  <label>
                    <span>Neues Passwort</span>
                    <input type="password" value={draft.reset_password} onChange={(event) => updateDraft(user.id, { reset_password: event.target.value })} />
                  </label>
                  <button className="icon-button secondary" disabled={savingUserId === user.id} type="button" onClick={() => void resetPassword(user.id)}>
                    <KeyRound aria-hidden="true" size={16} />
                    <span>Passwort setzen</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function toEditableUsers(users: AdminUser[]): Record<string, EditableUser> {
  return Object.fromEntries(users.map((user) => [String(user.id), toEditableUser(user)]));
}

function toEditableUser(user: AdminUser): EditableUser {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    is_active: user.is_active,
    person_id: user.person_id,
    reset_password: "",
  };
}

function roleOptions() {
  return Object.entries(roleLabels).map(([value, label]) => (
    <option key={value} value={value}>{label}</option>
  ));
}

function personOptions(people: Person[]) {
  return people.map((person) => (
    <option key={person.id} value={person.id}>
      {person.display_name}{person.is_active ? "" : " (inaktiv)"}
    </option>
  ));
}

function parsePersonId(value: string): number | null {
  return value ? Number(value) : null;
}

function readApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }
  if (typeof error.detail === "string") {
    return error.detail;
  }
  return error.message;
}
