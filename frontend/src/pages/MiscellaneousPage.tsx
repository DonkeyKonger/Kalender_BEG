import { useMemo, useState } from "react";

type MiscellaneousTabKey = "workerEvaluation" | "vehicles" | "toolsMaterial";

type MiscellaneousTab = {
  key: MiscellaneousTabKey;
  label: string;
};

const miscellaneousTabs: MiscellaneousTab[] = [
  { key: "workerEvaluation", label: "Monteurauswertung" },
  { key: "vehicles", label: "Fahrzeuge" },
  { key: "toolsMaterial", label: "Werkzeuge und Material" },
];

export function MiscellaneousPage() {
  const [activeTabKey, setActiveTabKey] = useState<MiscellaneousTabKey>("workerEvaluation");
  const activeTab = useMemo(
    () => miscellaneousTabs.find((tab) => tab.key === activeTabKey) ?? miscellaneousTabs[0],
    [activeTabKey],
  );

  return (
    <section className="miscellaneous-page page-stack">
      <header className="page-header miscellaneous-page-header">
        <div>
          <h1>Sonstige</h1>
        </div>
      </header>

      <div className="project-record-subtab-bar miscellaneous-subtab-bar">
        <div className="project-record-subtabs miscellaneous-subtabs" role="tablist" aria-label="Sonstige Bereiche">
          {miscellaneousTabs.map((tab) => {
            const isActive = tab.key === activeTabKey;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={isActive ? "is-active" : undefined}
                onClick={() => setActiveTabKey(tab.key)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <section className="miscellaneous-placeholder-panel" role="tabpanel" aria-label={activeTab.label}>
        <h2>{activeTab.label}</h2>
        <p>Noch keine Inhalte hinterlegt.</p>
      </section>
    </section>
  );
}
