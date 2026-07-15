import { ChevronDown, KeyRound, Save, Search, Trash2, UserCog, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EntityCard } from "../components/EntityCard";
import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { RoleBadge, StatusBadge, roleLabels } from "../components/StatusBadge";
import { useAuth } from "../auth/AuthContext";
import { officePagePermissionOptions } from "../config/officePagePermissions";
import { ApiError, api } from "../lib/api";
import type { OfficePagePermission, UserRole } from "../types/auth";
import type { Person } from "../types/person";
import type { AdminUser, AdminUserCreate, AdminUserUpdate } from "../types/user";

type EditableUser = {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  person_id: number | null;
  office_page_permissions: OfficePagePermission[];
  reset_password: string;
};

type UserBaseDraft = Pick<
  AdminUserCreate,
  "username" | "display_name" | "role" | "is_active" | "person_id" | "office_page_permissions"
>;
type DrawerState = { mode: "new" } | { mode: "edit"; userId: number } | null;

const emptyCreateForm: AdminUserCreate = {
  username: "",
  display_name: "",
  password: "",
  role: "monteur",
  is_active: true,
  person_id: null,
  office_page_permissions: [],
};

export function AdminUsersPage() {
  const { user: currentUser } = useAuth();
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
  const userGroups = useMemo(() => groupUsersByRole(filteredUsers), [filteredUsers]);

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
      setMessage("Benutzer angelegt. Beim ersten Login muss ein eigenes Passwort festgelegt werden.");
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
        office_page_permissions: draft.office_page_permissions,
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
      setMessage("Temporaeres Passwort gesetzt. Beim naechsten Login muss ein eigenes Passwort festgelegt werden.");
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

  async function deleteUser(userId: number) {
    if (userId === currentUser?.id) {
      setError("Der eigene Benutzer kann nicht geloescht werden.");
      setMessage(null);
      return;
    }
    const confirmed = window.confirm(
      "Benutzer wirklich loeschen? Diese Aktion kann nicht rueckgaengig gemacht werden.",
    );
    if (!confirmed) {
      return;
    }

    setSavingUserId(userId);
    setError(null);
    setMessage(null);
    try {
      await api.deleteUser(userId);
      setUsers((current) => current.filter((user) => user.id !== userId));
      setDrafts((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
      setDrawer(null);
      setMessage("Benutzer geloescht.");
    } catch (requestError) {
      setError(readApiError(requestError, "Benutzer konnte nicht geloescht werden."));
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

  return (
    <section className="admin-users-page overview-page">
      <div className="page-header entity-page-header overview-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Benutzer</h1>
        </div>
        <button className="icon-button overview-create" type="button" onClick={() => setDrawer({ mode: "new" })}>
          <UserPlus aria-hidden="true" size={17} />
          <span>Neuer Benutzer</span>
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}
      {message && <p className="form-info">{message}</p>}

      <div className="overview-toolbar">
        <div className="overview-toolbar-left">
          <label className="overview-search">
            <Search aria-hidden="true" size={17} />
            <input
              placeholder="Benutzer suchen"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </label>
        </div>
      </div>

      {isLoading && <div className="matrix-state">Benutzer werden geladen...</div>}

      {!isLoading && (
        <>
          {userGroups.length ? (
            <div className="overview-group-list">
              {userGroups.map((group) => (
                <section className="overview-group-section" key={group.key}>
                  <div className="overview-group-header">
                    <h2>
                      <ChevronDown aria-hidden="true" size={16} />
                      <span>{group.label}</span>
                    </h2>
                    <span className="overview-group-count">{group.users.length}</span>
                  </div>
                  <div className="entity-card-list overview-card-grid">
                    {group.users.map((adminUser) => {
                      const linkedPerson = adminUser.person_id ? peopleById.get(adminUser.person_id) : null;
                      return (
                        <EntityCard
                          key={adminUser.id}
                          className="overview-card user-overview-card"
                          color={userRoleColor(adminUser.role)}
                          title={adminUser.display_name}
                          subtitle={adminUser.username}
                          meta={[`Rolle: ${roleLabels[adminUser.role]}`, linkedPerson?.display_name ?? "Keine Person"]}
                          icon={<UserCog aria-hidden="true" size={17} />}
                          status={adminUser.is_active ? <RoleBadge role={adminUser.role} /> : <StatusBadge tone="inactive">Inaktiv</StatusBadge>}
                          isInactive={!adminUser.is_active}
                          onClick={() => setDrawer({ mode: "edit", userId: adminUser.id })}
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="empty-panel">
              <p>{users.length ? "Keine Treffer gefunden." : "Noch keine Benutzer vorhanden."}</p>
            </div>
          )}
        </>
      )}

      <EntityDetailDrawer
        isOpen={drawer?.mode === "new"}
        title="Neuer Benutzer"
        subtitle="Internen Zugang anlegen"
        onClose={closeDrawer}
        footer={(
          <button className="icon-button admin-create-submit-button" disabled={savingUserId === 0} type="button" onClick={() => void createUser()}>
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
            autoComplete="off"
            type="text"
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
            {selectedUser.id !== currentUser?.id && (
              <button
                className="icon-button danger danger-action"
                disabled={savingUserId === selectedUser.id}
                type="button"
                onClick={() => void deleteUser(selectedUser.id)}
              >
                <Trash2 aria-hidden="true" size={16} />
                <span>{savingUserId === selectedUser.id ? "Löscht..." : "Löschen"}</span>
              </button>
            )}
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
              <span>Benutzerpasswort zuruecksetzen</span>
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
              <span>Letztes vom Admin vergebenes Startpasswort</span>
              <input
                readOnly
                type="text"
                value={selectedUser.last_admin_password_plain ?? ""}
                placeholder="-"
              />
            </label>
            <label className="drawer-field">
              <span>Neues temporäres Startpasswort</span>
              <input
                autoComplete="off"
                type="text"
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
        <select
          value={draft.role}
          onChange={(event) => {
            const role = event.target.value as UserRole;
            onChange({
              role,
              ...(role === "office" ? {} : { office_page_permissions: [] }),
            });
          }}
        >
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
          {draft.role === "office" ? (
            <section className="office-page-permissions">
              <div className="office-page-permissions-heading">
                <strong>Sichtbare Hauptseiten</strong>
                <span>Legt fest, welche Hauptseiten dieser Büro-Nutzer öffnen darf.</span>
              </div>
              <div className="office-page-permissions-list">
                {officePagePermissionOptions.map((option) => (
                  <label className="checkbox-field" key={option.key}>
                    <input
                      checked={draft.office_page_permissions.includes(option.key)}
                      type="checkbox"
                      onChange={(event) => onChange({
                        office_page_permissions: toggleOfficePagePermission(
                          draft.office_page_permissions,
                          option.key,
                          event.target.checked,
                        ),
                      })}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </section>
          ) : null}
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
    office_page_permissions: user.office_page_permissions ?? [],
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

const userRoleOrder: UserRole[] = ["admin", "project_manager", "office", "monteur"];

function groupUsersByRole(users: AdminUser[]): Array<{ key: UserRole; label: string; users: AdminUser[] }> {
  return userRoleOrder
    .map((role) => ({
      key: role,
      label: roleLabels[role],
      users: users.filter((user) => user.role === role),
    }))
    .filter((group) => group.users.length > 0);
}

function userRoleColor(role: UserRole): string {
  if (role === "admin") {
    return "#0f3d6b";
  }
  if (role === "project_manager") {
    return "#1d5c99";
  }
  if (role === "office") {
    return "#0f766e";
  }
  return "#64748b";
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

function toggleOfficePagePermission(
  currentPermissions: OfficePagePermission[],
  permission: OfficePagePermission,
  checked: boolean,
): OfficePagePermission[] {
  const currentSet = new Set(currentPermissions);
  if (checked) {
    currentSet.add(permission);
  } else {
    currentSet.delete(permission);
  }
  return officePagePermissionOptions
    .map((option) => option.key)
    .filter((option) => currentSet.has(option));
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
