import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const source = await readFile(new URL('../src/pages/SiteDetailPage.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const panel = source.slice(source.indexOf('function ProjectFoldersPanel('), source.indexOf('function ProjectFolderDocumentBrowser('));
const compiled = await build({stdin:{contents:`
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
export function tree(counts,props={}) {
  const useProjectFolderFileCounts=(siteId,folders)=>counts;
  const ProjectFolderDocumentBrowser=()=> <div>Dokumente</div>;
  ${panel}
  return ProjectFoldersPanel({site:{id:42},folders:[{id:1,folder_key:'a',sort_order:1,name:'Angebote'},{id:2,folder_key:'b',sort_order:11,name:'Lieferantenbestellungen'}],selectedFolder:null,...props});
}
export const render=(counts,props)=>renderToStaticMarkup(tree(counts,props));
`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic'});
const module = {exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const collect = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(collect) : [node,...collect(node.props?.children)];

test('desktop folders show exact positive counts with accessible labels, including large totals', () => {
  const html = module.exports.render({a:1,b:12345});
  assert.match(html,/aria-label="1 Datei einschließlich Unterordner"/);
  assert.match(html,/aria-label="12345 Dateien einschließlich Unterordner"/);
  assert.match(html,/>12345<\/span>/);
  assert.equal((html.match(/class="project-folder-file-count"/g)||[]).length,2);
});

test('zero, unknown and failed counts leave an empty reserved slot without a badge or placeholder', () => {
  for (const counts of [{a:0,b:0},{a:null},{}]) {
    const html = module.exports.render(counts);
    assert.doesNotMatch(html,/project-folder-file-count|Dateianzahl nicht verfügbar|>–<|>0<\/span>/);
    assert.equal((html.match(/class="project-folder-count-slot"><\/span>/g)||[]).length,2);
  }
});

test('count badges preserve selection and file-drop handlers', () => {
  let selected, uploaded, dragOver;
  const node = module.exports.tree({a:4},{onSelectFolder:folder=>{selected=folder;},onUploadFiles:(folder,files)=>{uploaded={folder,files};},onDragOverFolder:key=>{dragOver=key;}});
  const button = collect(node).find(item=>item.type==='button');
  button.props.onClick();
  assert.equal(selected.folder_key,'a');
  button.props.onDrop({preventDefault(){},stopPropagation(){},dataTransfer:{files:['test.pdf']}});
  assert.equal(uploaded.folder.folder_key,'a');
  assert.deepEqual(uploaded.files,['test.pdf']);
  assert.equal(dragOver,null);
});

test('desktop reuses the existing seeded background count cache without counting document rows', () => {
  assert.match(source,/import \{ useProjectFolderFileCounts \} from "\.\/useProjectFolderFileCounts"/);
  assert.match(panel,/useProjectFolderFileCounts\(site.id, folders\)/);
  assert.ok(panel.indexOf('useProjectFolderFileCounts(')<panel.indexOf('if (isLoading)'));
  assert.doesNotMatch(panel,/documents\.items\.length|projectFolderFileCount\(/);
});

test('wider desktop navigation keeps a responsive fallback and muted count styling', () => {
  assert.match(css,/\.project-folder-workspace \{[^}]*grid-template-columns: minmax\(240px, 280px\) minmax\(0, 1fr\)/);
  assert.match(css,/@media \(max-width: 760px\) \{[^]*?\.project-folder-workspace \{\s*grid-template-columns: 1fr;/);
  const badge = css.slice(css.indexOf('.site-detail-page.is-project-file-workspace .project-folder-card .project-folder-file-count {')).split('}')[0];
  assert.match(badge,/background: #e5ebf2;/);
  assert.match(badge,/color: #52657c;/);
  assert.match(badge,/font-variant-numeric: tabular-nums;/);
});
