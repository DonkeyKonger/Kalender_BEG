import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../src/pages/MobileAssignmentDetailPage.tsx', import.meta.url), 'utf8');
const tile = await readFile(new URL('../src/components/MobileFolderPhotoTile.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/pages/MobileProjectFolders.css', import.meta.url), 'utf8');

test('photo folder and its descendants use a grid while retaining other files and navigation', () => {
  assert.match(page, /selectedFolder.folder_key === "fotos" \? "mobile-folder-photo-grid" : "mobile-folder-file-list"/);
  assert.match(page, /!item.is_folder && getProjectDocumentKind\(item\) === "image"/);
  assert.match(page, /<MobileFolderPhotoTile[\s\S]*?onOpen=\{\(\) => void handleOpenDocument\(item\)\}/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /mobile-folder-file-card \{ grid-column: 1 \/ -1/);
});

test('tiles request thumbnails near viewport, release blobs and preserve opening on preview failure', () => {
  assert.match(tile, /new IntersectionObserver/);
  assert.match(tile, /api.projectFolderDocumentThumbnail/);
  assert.doesNotMatch(tile, /projectFolderDocumentContent/);
  assert.match(tile, /URL.revokeObjectURL\(objectUrl\)/);
  assert.match(tile, /observer\?\.disconnect\(\)/);
  assert.match(tile, /item.last_modified_date_time/);
  assert.match(tile, /disabled=\{isOpening\}/);
  assert.match(tile, /Vorschau nicht verfügbar/);
  assert.match(tile, /aria-label=\{`Foto öffnen: \$\{item.name\}`\}/);
});
