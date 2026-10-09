import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/CustomersPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);
const helpers = pageSource.slice(pageSource.indexOf("function compareCustomers("), pageSource.indexOf("function formatCustomerAddress("));
const compiled = ts.transpileModule(helpers, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const { customerInitial, groupCustomersAlphabetically, compareCustomers } = new Function(`${compiled}; return {customerInitial, groupCustomersAlphabetically, compareCustomers};`)();

test("customer directory uses compact fixed-height rows and an independent detail selection", () => {
  assert.match(styles, /\.customer-directory-row \{[^}]*height: 48\.4px/s);
  assert.match(styles, /\.customer-directory-row-copy strong, \.customer-directory-row-copy > span \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/s);
  assert.match(pageSource, /onClick=\{\(\) => setPreviewCustomerId\(customer.id\)\}/);
  assert.match(pageSource, /filteredCustomers.find\(\(customer\) => customer.id === previewCustomerId\)\s*\?\? filteredCustomers\[0\] \?\? null/);
  assert.doesNotMatch(pageSource, /Kundenakte öffnen|openCustomerDrawer/);
});

test("customer list scales typography, controls and icons by ten percent without widening the column", () => {
  assert.match(styles, /\.customer-directory \{[^}]*grid-template-columns: minmax\(0, 1\.2fr\) minmax\(0, 1fr\)/s);
  assert.match(styles, /\.customer-directory-row-copy strong \{[^}]*font-size: 13\.2px/);
  assert.match(styles, /\.customer-directory-row-copy > span \{[^}]*font-size: 12\.1px/);
  assert.match(styles, /\.customer-directory-row > svg:first-child \{ width: 20\.9px; height: 20\.9px;/);
  assert.match(styles, /\.customer-directory-tools \.overview-search input \{ min-height: 35\.2px; font-size: 13\.2px;/);
  assert.match(styles, /\.customer-alphabet button \{[^}]*font-size: 11px/s);
});

test("alphabet filter includes umlauts and a group for other initials", () => {
  for (const [name, letter] of [[" Äcker", "A"], ["Öltechnik", "O"], ["Überbau", "U"], ["ebm", "E"], ["123 Firma", "#"], ["", "#"]]) {
    assert.equal(customerInitial(name), letter);
  }
  const customers = ["Zeta", "Öltechnik", "Alpha", "Äcker", "123 Firma"].map((company_name) => ({ company_name }));
  const groups = groupCustomersAlphabetically([...customers].sort(compareCustomers));
  assert.deepEqual(groups.map((group) => group.key), ["#", "A", "O", "Z"]);
  assert.equal(groups[1].customers.length, 2);
  assert.equal(groups[0].label, "Sonstige");
  assert.equal(customers[0].company_name, "Zeta");
  assert.match(pageSource, /letterFilter === "all" \|\| customerInitial\(customer.company_name\) === letterFilter/);
  assert.match(pageSource, /return sortDescending \? groups.reverse\(\) : groups/);
});

test("customer details retain contacts, permissions, full records and empty results", () => {
  assert.match(pageSource, /canEdit && !isEditingCustomer && <button className="icon-button secondary"/);
  assert.match(pageSource, /CustomerContactEditor key=\{previewCustomer.id\} canEdit=\{canEdit\}/);
  assert.match(pageSource, /saveCustomerContacts\(previewCustomer.id, contacts, removedEmails\)/);
  assert.match(pageSource, /Keine Treffer gefunden/);
  assert.match(pageSource, /Noch keine Kunden vorhanden/);
  assert.match(pageSource, /useEffect\(\(\) => \{\s*setIsEditingCustomer\(false\);\s*\}, \[previewCustomer\?\.id\]\)/);
});

test("switching customers keeps the selected detail tab and only ends record editing", () => {
  const effect = pageSource.match(/useEffect\(\(\) => \{([^{}]*)\}, \[previewCustomer\?\.id\]\)/)[1];
  for (const initialTab of ["master", "contacts", "projects"]) {
    let tab = initialTab;
    let editing = true;
    new Function("setPreviewTab", "setIsEditingCustomer", effect)(value => { tab = value; }, value => { editing = value; });
    assert.equal(tab, initialTab);
    assert.equal(editing, false);
  }
  assert.match(pageSource, /useState<"master" \| "contacts" \| "projects">\("master"\)/);
});

test("the full customer record and edit form live inside the right detail panel", () => {
  assert.match(styles, /\.customer-preview-actions \.icon-button \{ border-radius: 0; \}/);
  assert.match(styles, /\.customer-record-edit-actions \.icon-button \{ border-radius: 0; \}/);
  const panel = pageSource.slice(pageSource.indexOf('<section className="customer-preview"'), pageSource.indexOf('<EntityDetailDrawer'));
  for (const content of ['CustomerNotesSection', 'CustomerProjectsList', 'CustomerContactEditor', 'CustomerFields', 'customer-projects-tab', 'customer-record-edit-actions']) {
    assert.ok(panel.includes(content), content);
  }
  assert.match(panel, /saveCustomerNotes\(previewCustomer.id, notes\)/);
  assert.match(panel, /saveCustomer\(previewCustomer.id\)/);
  assert.match(panel, /removeCustomer\(previewCustomer.id\)/);
  assert.match(panel, /onClick=\{cancelCustomerEdit\}/);
  assert.equal((pageSource.match(/<EntityDetailDrawer/g) ?? []).length, 1);
  assert.match(pageSource, /isOpen=\{drawer\?\.mode === "new"\}/);
  assert.doesNotMatch(pageSource, /drawer\?\.mode === "edit"/);
  assert.doesNotMatch(pageSource, /disabled=\{isEditingCustomer \|\| savingCustomerId !== null\}/);
  assert.match(pageSource, /disabled=\{savingCustomerId !== null\}/);
  assert.match(pageSource, /\[selectedCustomer.id\]: current\[selectedCustomer.id\] \?\? toEditableCustomer\(selectedCustomer\)/);
  assert.match(pageSource, /Ungespeicherter Entwurf · über Bearbeiten fortsetzen/);
});

test("customer directory stacks on mobile and independently scrolls the desktop list", () => {
  assert.match(styles, /\.customer-directory-results \{ overflow: auto; min-height: 0; flex: 1; \}/);
  assert.match(styles, /@media \(max-width: 760px\) \{\s*\.customer-directory \{ grid-template-columns: minmax\(0, 1fr\); height: auto/);
  assert.match(styles, /\.customer-directory-results \{ max-height: 330px; flex: auto; \}/);
});

test("contacts use responsive cards with explicit editing and clickable communication channels", () => {
  const editor = pageSource.slice(pageSource.indexOf("function CustomerContactEditor("), pageSource.indexOf("function CustomerPhoneLink("));
  assert.match(editor, /<article className="customer-contact-card"/);
  assert.match(editor, /canEdit && draft\?\.key === item.key/);
  assert.match(editor, /Kontakt bearbeiten:/);
  assert.match(editor, /href=\{`mailto:\$\{item.email.trim\(\)\}`\}/);
  assert.match(editor, /<CustomerPhoneLink phone=\{item.phone\}/);
  assert.match(editor, /"Neuer Ansprechpartner" : "-"/);
  assert.doesNotMatch(editor, /Name nicht hinterlegt/);
  assert.match(editor, /aria-label="Ansprechpartner suchen"/);
  assert.match(editor, /Keine Telefonnummer hinterlegt/);
  assert.doesNotMatch(editor, /onBlur=/);
  assert.match(editor, /await onSaveContacts\(payload\)\) \{\s*setDraft\(null\)/);
  assert.match(editor, /if \(saved\) setDraft\(null\)/);
  assert.match(editor, /type="button" disabled=\{isSaving\} onClick=\{\(\) => setDraft\(null\)\}>Abbrechen/);
  assert.match(styles, /\.customer-contact-cards \{[^}]*repeat\(auto-fit, minmax\(min\(100%, 310px\), 1fr\)\)/);
  assert.match(styles, /\.customer-contact-card \.icon-button \{ border-radius: 0;/);
});

test("reopening a customer preserves its draft and cancel only resets that customer's draft", () => {
  const editActions = pageSource.slice(pageSource.indexOf("  function startCustomerEdit()"), pageSource.indexOf("  function closeDrawer()"));
  const compiledActions = ts.transpileModule(editActions, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const run = new Function("selectedCustomer", "drafts", `
    let editing = false;
    const toEditableCustomer = customer => ({...customer});
    const setDrafts = update => {drafts = update(drafts);};
    const setIsEditingCustomer = value => {editing = value;};
    const setError = () => {};
    ${compiledActions}
    return {startCustomerEdit, cancelCustomerEdit, state:()=>({drafts,editing})};
  `);
  const actions = run({id:1,company_name:"Saved name"}, {1:{id:1,company_name:"Pending name"},2:{id:2,company_name:"Other draft"}});
  actions.startCustomerEdit();
  assert.equal(actions.state().editing,true);
  assert.equal(actions.state().drafts[1].company_name,"Pending name");
  actions.cancelCustomerEdit();
  assert.equal(actions.state().editing,false);
  assert.equal(actions.state().drafts[1].company_name,"Saved name");
  assert.equal(actions.state().drafts[2].company_name,"Other draft");
});
