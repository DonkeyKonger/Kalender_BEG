import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { updateSiteAddressDraft } from '../src/lib/siteAddressDraft.ts';

const draft = { postal_code: '28832', city: 'Achim', location: 'Achim', street: 'Finienweg', house_number: '16', address: 'Finienweg 16, 28832 Achim', latitude: 53, longitude: 9, location_status: 'geocoded', name: 'Testbaustelle' };

test('manual house number correction retains suffixes and updates the formatted address', () => {
  const patch = updateSiteAddressDraft(draft, 'house_number', '16a');
  assert.equal(patch.house_number, '16a');
  assert.equal(patch.address, 'Finienweg 16a, 28832 Achim');
  assert.equal(patch.latitude, null);
  assert.equal(patch.longitude, null);
  assert.equal(patch.location_status, 'unchecked');
  assert.equal(patch.name, undefined);
  assert.equal(draft.house_number, '16');
});

test('all four address parts can be corrected or cleared without numeric coercion', () => {
  assert.equal(updateSiteAddressDraft(draft, 'postal_code', '01234').postal_code, '01234');
  assert.equal(updateSiteAddressDraft(draft, 'street', 'Neue Straße').address, 'Neue Straße 16, 28832 Achim');
  const cityPatch = updateSiteAddressDraft(draft, 'city', 'Bremen');
  assert.equal(cityPatch.city, 'Bremen');
  assert.equal(cityPatch.location, 'Bremen');
  assert.equal(updateSiteAddressDraft(draft, 'house_number', '').house_number, null);
  assert.equal(updateSiteAddressDraft(draft, 'house_number', '').address, 'Finienweg, 28832 Achim');
  assert.deepEqual(updateSiteAddressDraft(draft, 'house_number', '16'), {});
});

test('new site enables editable fields while retaining address search and existing disabled permissions', async () => {
  const source = await readFile(new URL('../src/pages/SitesPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /hideTopLocationField\s+editableAddress/);
  assert.match(source, /editableAddress = false/);
  assert.match(source, /disabled=\{disabled\}\s+value=\{draft\[field\] \?\? ""\}/);
  assert.match(source, /onChange\(updateSiteAddressDraft\(draft, field, event.target.value\)\)/);
  assert.match(source, /address: result.label,[\s\S]*?house_number: result.house_number,[\s\S]*?location_status: "geocoded"/);
});
