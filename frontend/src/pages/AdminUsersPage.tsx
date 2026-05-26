import { KeyRound, PlugZap, Save, UserCog, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EntityCard } from "../components/EntityCard";
import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { RoleBadge, StatusBadge, roleLabels } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { UserRole } from "../types/auth";
import type { Person } from "../types/person";
import type { MicrosoftGraphConnectionTestResponse } from "../types/admin";
import type { AdminUser, AdminUserCreate, AdminUserUpdate } from "../types/user";

type EditableUser = {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  person_id: number | null;
  reset_password: string;
};

type UserBaseDraft = Pick<AdminUserCreate, "username" | "display_name" | "role" | "is_active" | "person_id">;
type DrawerState = { mode: "new" } | { mode: "edit"; userId: number } | null;

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
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [savingUserId, setSavingUserId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [graphTestResult, setGraphTestResult] = useState<MicrosoftGraphConnectionTestResponse | null>(null);
  const [graphTestError, setGraphTestError] = useState<string | null>(null);
  const [isTestingGraph, setIsTestingGraph] = useState(false);

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
  const filteredUsers = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) {
      return users;
    }
    return users.filter((user) => userSearchText(user, peopleById).includes(needle));
  }, [peopleById, searchTerm, users]);

  const selectedUser = drawer?.mode === "edit"
    ? users.find((item) => item.id === drawer.userId) ?? null
    : null;
  const selectedDraft = drawer?.mode === "edit" && selectedUser
    ? drafts[selectedUser.id] ?? toEditableUser(selectedUser)
    : null;

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
      setUsers((current) => [...current, created].sort(compareUsers));
      setDrafts((current) => ({ ...current, [created.id]: toEditableUser(created) }));
      setCreateForm(emptyCreateForm);
      setDrawer(null);
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
    setUsers((current) => current.map((user) => user.id === updated.id ? updated : user).sort(compareUsers));
    setDrafts((current) => ({ ...current, [updated.id]: toEditableUser(updated) }));
  }

  function updateDraft(userId: number, values: Partial<EditableUser>) {
    setDrafts((current) => ({
      ...current,
      [userId]: { ...current[userId], ...values },
    }));
  }

  function closeDrawer() {
    setDrawer(null);
  }

  async function testMicrosoftGraphConnection() {
    setIsTestingGraph(true);
    setGraphTestError(null);
    setGraphTestResult(null);
    try {
      setGraphTestResult(await api.testMicrosoftGraphConnection());
    } catch (requestError) {
      setGraphTestError(readApiError(requestError, "Microsoft Graph konnte nicht getestet werden."));
    } finally {
      setIsTestingGraph(false);
    }
  }

  return (
    <section className="admin-users-page">
      <div className="page-header entity-page-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Benutzer</h1>
        </div>
        <button className="icon-button" type="button" onClick={() => setDrawer({ mode: "new" })}>
          <UserPlus aria-hidden="true" size={17} />
          <span>Neuer Benutzer</span>
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}
      {message && <p className="form-info">{message}</p>}

      <MicrosoftGraphTestPanel
        result={graphTestResult}
        error={graphTestError}
        isLoading={isTestingGraph}
        onTest={() => void testMicrosoftGraphConnection()}
      />

      <input
        className="entity-search"
        placeholder="Benutzer suchen"
        value={searchTerm}
        onChange={(event) => setSearchTerm(event.target.value)}
      />

      {isLoading && <div className="matrix-state">Benutzer werden geladen...</div>}

      {!isLoading && (
        <div className="entity-card-list">
          {filteredUsers.map((adminUser) => {
            const linkedPerson = adminUser.person_id ? peopleById.get(adminUser.person_id) : null;
            return (
              <EntityCard
                key={adminUser.id}
                title={adminUser.display_name}
                subtitle={`${adminUser.username} · Rolle: ${roleLabels[adminUser.role]}`}
                meta={[linkedPerson?.display_name ?? "Keine Person"]}
                icon={<UserCog aria-hidden="true" size={17} />}
                status={adminUser.is_active ? <RoleBadge role={adminUser.role} /> : <StatusBadge tone="inactive">Inaktiv</StatusBadge>}
                isInactive={!adminUser.is_active}
                onClick={() => setDrawer({ mode: "edit", userId: adminUser.id })}
              />
            );
          })}
          {!filteredUsers.length && (
            <div className="empty-panel">
              <p>{users.length ? "Keine Treffer gefunden." : "Noch keine Benutzer vorhanden."}</p>
            </div>
          )}
        </div>
      )}

      <EntityDetailDrawer
        isOpen={drawer?.mode === "new"}
        title="Neuer Benutzer"
        subtitle="Internen Zugang anlegen"
        onClose={closeDrawer}
        footer={(
          <button className="icon-button" disabled={savingUserId === 0} type="button" onClick={() => void createUser()}>
            <UserPlus aria-hidden="true" size={17} />
            <span>Benutzer anlegen</span>
          </button>
        )}
      >
        <UserBaseFields
          draft={createForm}
          people={people}
          onChange={(values) => setCreateForm((current) => ({ ...current, ...values }))}
        />
        <label className="drawer-field">
          <span>Startpasswort</span>
          <input
            type="password"
            value={createForm.password}
            onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))}
          />
        </label>
      </EntityDetailDrawer>

      <EntityDetailDrawer
        isOpen={drawer?.mode === "edit" && Boolean(selectedUser && selectedDraft)}
        title={selectedUser ? "Benutzer bearbeiten" : "Benutzer"}
        subtitle={selectedUser ? `${selectedUser.username} · ${roleLabels[selectedUser.role]}` : undefined}
        onClose={closeDrawer}
        footer={selectedUser && selectedDraft ? (
          <>
            <button
              className="icon-button secondary"
              disabled={savingUserId === selectedUser.id}
              type="button"
              onClick={() => void saveUser(selectedUser.id)}
            >
              <Save aria-hidden="true" size={16} />
              <span>Speichern</span>
            </button>
            <button
              className="icon-button secondary"
              disabled={savingUserId === selectedUser.id || !selectedDraft.is_active}
              type="button"
              onClick={() => void disableUser(selectedUser.id)}
            >
              <span>Deaktivieren</span>
            </button>
            <button
              className="icon-button secondary"
              disabled={savingUserId === selectedUser.id}
              type="button"
              onClick={() => void resetPassword(selectedUser.id)}
            >
              <KeyRound aria-hidden="true" size={16} />
              <span>Passwort setzen</span>
            </button>
          </>
        ) : undefined}
      >
        {selectedUser && selectedDraft && (
          <>
            <UserBaseFields
              draft={selectedDraft}
              people={people}
              onChange={(values) => updateDraft(selectedUser.id, values)}
            />
            <label className="drawer-field">
              <span>Neues Passwort</span>
              <input
                type="password"
                value={selectedDraft.reset_password}
                onChange={(event) => updateDraft(selectedUser.id, { reset_password: event.target.value })}
              />
            </label>
          </>
        )}
      </EntityDetailDrawer>
    </section>
  );
}

function MicrosoftGraphTestPanel({
  result,
  error,
  isLoading,
  onTest,
}: {
  result: MicrosoftGraphConnectionTestResponse | null;
  error: string | null;
  isLoading: boolean;
  onTest: () => void;
}) {
  return (
    <section className="admin-integration-panel">
      <div className="admin-integration-panel-header">
        <div>
          <h2>Microsoft 365 Verbindung</h2>
          <p>Prüft die konfigurierte Graph-Verbindung über das Backend. Es werden keine Ordner erstellt.</p>
        </div>
        <button className="icon-button secondary" disabled={isLoading} type="button" onClick={onTest}>
          <PlugZap aria-hidden="true" size={16} />
          <span>{isLoading ? "Teste..." : "Microsoft Graph testen"}</span>
        </button>
      </div>

      {error ? <p className="form-error">{error}</p> : null}
      {result ? <MicrosoftGraphTestResult result={result} /> : null}
    </section>
  );
}

function MicrosoftGraphTestResult({ result }: { result: MicrosoftGraphConnectionTestResponse }) {
  return (
    <div className={`admin-integration-result ${result.connected ? "is-connected" : "is-disconnected"}`}>
      <div>
        <span>Graph aktiviert</span>
        <strong>{result.graph_enabled ? "Ja" : "Nein"}</strong>
      </div>
      <div>
        <span>Verbunden</span>
        <strong>{result.connected ? "Ja" : "Nein"}</strong>
      </div>
      {result.reason ? (
        <div className="is-wide">
          <span>Hinweis</span>
          <strong>{result.reason}</strong>
        </div>
      ) : null}
      {result.status_code ? (
        <div>
          <span>Statuscode</span>
          <strong>{result.status_code}</strong>
        </div>
      ) : null}
      {result.missing_config.length ? (
        <div className="is-wide">
          <span>Fehlende Konfiguration</span>
          <strong>{result.missing_config.join(", ")}</strong>
        </div>
      ) : null}
      <GraphResource label="Drive" resource={result.drive} />
      <GraphResource label="Root-Ordner" resource={result.root_folder} />
    </div>
  );
}

function GraphResource({ label, resource }: { label: string; resource: MicrosoftGraphConnectionTestResponse["drive"] }) {
  if (!resource) {
    return null;
  }
  return (
    <div className="is-wide">
      <span>{label}</span>
      <strong>{[resource.name, resource.id].filter(Boolean).join(" · ") || "Gefunden"}</strong>
    </div>
  );
}

function UserBaseFields({
  draft,
  people,
  onChange,
}: {
  draft: UserBaseDraft;
  people: Person[];
  onChange: (values: Partial<UserBaseDraft>) => void;
}) {
  return (
    <div className="admin-form-grid drawer-form-grid">
      <label>
        <span>Anmeldename</span>
        <input value={draft.username} onChange={(event) => onChange({ username: event.target.value })} />
      </label>
      <label>
        <span>Anzeigename</span>
        <input value={draft.display_name} onChange={(event) => onChange({ display_name: event.target.value })} />
      </label>
      <label>
        <span>Rolle</span>
        <select value={draft.role} onChange={(event) => onChange({ role: event.target.value as UserRole })}>
          {roleOptions()}
        </select>
      </label>
      <label>
        <span>Person</span>
        <select value={draft.person_id ?? ""} onChange={(event) => onChange({ person_id: parsePersonId(event.target.value) })}>
          <option value="">Keine Zuordnung</option>
          {personOptions(people)}
        </select>
      </label>
      <label className="checkbox-field">
        <input checked={draft.is_active} type="checkbox" onChange={(event) => onChange({ is_active: event.target.checked })} />
        <span>Aktiv</span>
      </label>
    </div>
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

function compareUsers(left: AdminUser, right: AdminUser): number {
  return left.username.localeCompare(right.username);
}

function userSearchText(user: AdminUser, peopleById: Map<number, Person>): string {
  const linkedPerson = user.person_id ? peopleById.get(user.person_id) : null;
  return [
    user.username,
    user.display_name,
    roleLabels[user.role],
    linkedPerson?.display_name,
    user.is_active ? "Aktiv" : "Inaktiv",
  ].filter(Boolean).join(" ").toLowerCase();
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
