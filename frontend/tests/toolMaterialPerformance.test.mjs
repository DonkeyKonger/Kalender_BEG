import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildToolMaterialSearchParams } from "../src/lib/toolMaterialFilters.ts";


const [pageSource, apiSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MiscellaneousPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);


test("the tool table requests bounded server-side pages", () => {
  const search = buildToolMaterialSearchParams({
    page: 3,
    pageSize: 100,
    search: "Bosch",
    categories: ["testing_equipment"],
    sortBy: "beg_number",
    sortDirection: "desc",
  });
  assert.equal(search.get("page"), "3");
  assert.equal(search.get("page_size"), "100");
  assert.equal(search.get("search"), "Bosch");
  assert.deepEqual(search.getAll("values_category"), ["testing_equipment"]);
  assert.equal(search.get("sort_by"), "beg_number");
  assert.match(apiSource, /toolMaterialItemsPage[\s\S]*\/admin\/tool-material-items\/page/);
  assert.match(pageSource, /const TOOL_MATERIAL_PAGE_SIZE = 100/);
  assert.match(pageSource, /api\.toolMaterialItemsPage\(\{[\s\S]*pageSize: TOOL_MATERIAL_PAGE_SIZE/);
  assert.match(pageSource, /Seite \{totalPages > 0 \? page : 0\} von \{totalPages\}/);
});


test("searches are debounced and stale page requests cannot overwrite newer results", () => {
  assert.match(pageSource, /window\.setTimeout\(\(\) => \{[\s\S]*setDebouncedSearchTerm\(searchTerm\.trim\(\)\);[\s\S]*\}, 300\)/);
  assert.match(pageSource, /const requestId = \+\+listRequestIdRef\.current/);
  assert.match(pageSource, /requestId === listRequestIdRef\.current/);
  assert.match(pageSource, /pageCacheRef\.current\.get\(cacheKey\)/);
  assert.match(pageSource, /pageRequestCacheRef\.current\.get\(cacheKey\)/);
  assert.match(pageSource, /TOOL_MATERIAL_PAGE_CACHE_MS = 30_000/);
});


test("filter values and edit details load only when requested", () => {
  assert.doesNotMatch(pageSource, /useEffect\(\(\) => \{[\s\S]{0,250}toolMaterialFilterOptions\(\)/);
  assert.match(pageSource, /toolMaterialFilterOptionsForColumn\(key\)/);
  assert.match(apiSource, /filter-options\/\$\{encodeURIComponent\(column\)\}/);
  assert.match(pageSource, /const item = await api\.toolMaterialItem\(itemId\)/);
  assert.doesNotMatch(pageSource, /toToolMaterialDrafts/);
});


test("the compact Office pagination remains outside the scrolling table", () => {
  assert.match(pageSource, /miscellaneous-tools-table-wrap[\s\S]*miscellaneous-tools-pagination/);
  assert.match(styles, /\.miscellaneous-tools-pagination \{[^}]*flex:\s*0 0 auto;[^}]*justify-content:\s*space-between/s);
  assert.match(styles, /\.miscellaneous-tools-table-wrap \{[^}]*overflow:\s*auto/s);
});
