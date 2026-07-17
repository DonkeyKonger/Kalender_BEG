import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/AbsencesPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

test("one locally selected absence person row can be toggled or cleared with Escape", () => {
  assert.match(pageSource, /const \[highlightedPersonId, setHighlightedPersonId\] = useState<number \| null>\(null\)/);
  assert.match(pageSource, /current === row\.person\.id \? null : row\.person\.id/);
  assert.match(pageSource, /event\.key === "Escape"[\s\S]*setHighlightedPersonId\(null\)/);
  assert.match(pageSource, /className=\{`absence-person-row\$\{isPersonHighlighted \? " is-highlighted" : ""\}`\}/);
  assert.match(pageSource, /aria-selected=\{isPersonHighlighted\}/);
});

test("only the focusable person name controls the row highlight", () => {
  assert.match(pageSource, /className="absence-person-highlight-trigger"/);
  assert.match(pageSource, /aria-pressed=\{isPersonHighlighted\}/);
  assert.match(pageSource, /<span>\{row\.person\.display_name\}<\/span>/);
  assert.match(pageSource, /<tr className="absence-person-group-row">/);
  assert.doesNotMatch(pageSource, /absence-person-group-row[^>]*is-highlighted/);
  assert.match(styles, /\.absence-person-highlight-trigger \{[^}]*cursor:\s*pointer/s);
  assert.match(styles, /\.absence-person-highlight-trigger:focus-visible \{/);
});

test("the full selected row uses a non-interactive translucent overlay above existing cell colors", () => {
  assert.match(styles, /\.absence-person-row\.is-highlighted > th::after,[\s\S]*\.absence-person-row\.is-highlighted > td::after \{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*rgb\(59 130 246 \/ 9%\);[^}]*pointer-events:\s*none/s);
  assert.match(styles, /\.absence-person-row\.is-highlighted > \.absence-person-col::after \{[^}]*rgb\(59 130 246 \/ 16%\)/s);
  assert.match(styles, /\.absence-person-row\.is-highlighted \.absence-cell-stack \{[^}]*z-index:\s*1/s);
  assert.match(styles, /\.absence-block-vacation \{[^}]*background:\s*#16a34a/s);
  assert.match(styles, /\.absence-block-sick \{[^}]*background:\s*#dc2626/s);
  assert.match(styles, /\.absence-block-school \{[^}]*background:\s*#2563eb/s);
});
