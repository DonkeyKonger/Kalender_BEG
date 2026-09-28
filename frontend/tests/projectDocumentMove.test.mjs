import assert from "node:assert/strict";
import test from "node:test";
import { applyDocumentMoves, sameDocumentLocation } from "../src/lib/projectDocumentMove.ts";

const root = { folderKey: "fotos", parentId: null };
const child = { folderKey: "fotos", parentId: "archiv" };
const other = { folderKey: "angebote", parentId: null };
const file = { id: "file", name: "Foto.jpg", is_folder: false };
const folder = { id: "archiv", name: "Archiv", is_folder: true };

test("move updates source and destination without affecting unrelated folders", () => {
  const moves = [{ source: root, target: child, item: file }];
  assert.deepEqual(applyDocumentMoves([folder, file], root, moves), [folder]);
  assert.deepEqual(applyDocumentMoves([], child, moves), [file]);
  assert.deepEqual(applyDocumentMoves([folder], other, moves), [folder]);
});

test("move to parent or different standard folder never duplicates an existing item", () => {
  assert.deepEqual(applyDocumentMoves([file], root, [{ source: child, target: root, item: file }]), [file]);
  assert.deepEqual(applyDocumentMoves([], other, [{ source: child, target: other, item: file }]), [file]);
  assert.equal(sameDocumentLocation(root, other), false);
  assert.equal(sameDocumentLocation(root, child), false);
  assert.equal(sameDocumentLocation(root, { ...root }), true);
});
