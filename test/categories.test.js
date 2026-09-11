'use strict';

const test = require('node:test');
const assert = require('node:assert');

const categories = require('../src/lib/categories');

function cfg(order = [], serviceCategories = []) {
  return {
    settings: { categoryOrder: order },
    services: serviceCategories.map((category, i) => ({ id: `s${i}`, name: `S${i}`, category })),
  };
}

test('listed categories lead in their stored order; unlisted ones follow alphabetically', () => {
  const c = cfg(['Media', 'Tools'], ['Zeta', 'Media', 'alpha', '']);
  assert.deepEqual(categories.list(c), ['Media', 'Tools', 'alpha', 'Zeta']);
});

test('names are unique regardless of case', () => {
  assert.deepEqual(categories.list(cfg(['Media'], ['media', 'MEDIA'])), ['Media']);
});

test('a category can exist with nothing in it', () => {
  const c = cfg(['Media'], []);
  assert.equal(categories.add(c, 'Books').ok, true);
  assert.deepEqual(categories.withCounts(c), [{ name: 'Media', count: 0 }, { name: 'Books', count: 0 }]);
});

test('counts match services case-insensitively', () => {
  assert.deepEqual(categories.withCounts(cfg(['A', 'B'], ['A', 'a', ''])), [
    { name: 'A', count: 2 }, { name: 'B', count: 0 },
  ]);
});

test('adding a duplicate is refused, whatever the case', () => {
  const result = categories.add(cfg(['Media']), 'MEDIA');
  assert.equal(result.ok, false);
  assert.match(result.error, /"Media" already exists/);
});

test('"Ungrouped" is reserved for services without a category', () => {
  assert.equal(categories.add(cfg([]), 'ungrouped').ok, false);
});

test('names are tidied, and spaces and hyphens are ordinary characters', () => {
  assert.deepEqual(categories.clean('  Big   Media  '), { ok: true, name: 'Big Media' });
  assert.deepEqual(categories.clean('Media-Server'), { ok: true, name: 'Media-Server' });
  assert.equal(categories.clean('').ok, false);
  assert.equal(categories.clean('x'.repeat(41)).ok, false);
  assert.equal(categories.clean(`bad${String.fromCharCode(1)}name`).ok, false, 'control characters are refused');
});

test('rename refiles every service and keeps the category in place', () => {
  const c = cfg(['A', 'B', 'C'], ['B', 'B', 'C']);
  const result = categories.rename(c, 'B', 'Bee');
  assert.equal(result.ok, true);
  assert.equal(result.moved, 2);
  assert.deepEqual(categories.list(c), ['A', 'Bee', 'C']);
  assert.deepEqual(c.services.map((s) => s.category), ['Bee', 'Bee', 'C']);
});

test('rename finds the old name case-insensitively', () => {
  const c = cfg(['Media'], ['Media']);
  assert.equal(categories.rename(c, 'media', 'Films').ok, true);
  assert.deepEqual(categories.list(c), ['Films']);
});

test('a rename that only changes case is allowed', () => {
  const c = cfg(['Media'], ['Media']);
  assert.equal(categories.rename(c, 'Media', 'MEDIA').ok, true);
  assert.equal(c.services[0].category, 'MEDIA');
});

test('renaming onto another existing category is refused', () => {
  const result = categories.rename(cfg(['A', 'B']), 'A', 'b');
  assert.equal(result.ok, false);
  assert.match(result.error, /"B" already exists/);
});

test('renaming a category that was never listed lists it under the new name', () => {
  const c = cfg([], ['Old']);
  assert.equal(categories.rename(c, 'Old', 'New').ok, true);
  assert.deepEqual(c.settings.categoryOrder, ['New']);
  assert.equal(c.services[0].category, 'New');
});

test('deleting a category moves its services to Ungrouped instead of losing them', () => {
  const c = cfg(['A', 'B'], ['A', 'B', 'A']);
  const result = categories.remove(c, 'a');
  assert.equal(result.ok, true);
  assert.equal(result.moved, 2);
  assert.deepEqual(categories.list(c), ['B']);
  assert.deepEqual(c.services.map((s) => s.category), ['', 'B', '']);
  assert.equal(c.services.length, 3, 'no service was removed');
});

test('deleting a category that does not exist says so', () => {
  assert.equal(categories.remove(cfg(['A']), 'Nope').ok, false);
});

test('reorder ignores unknown names and keeps anything left out', () => {
  const c = cfg(['A', 'B', 'C']);
  assert.deepEqual(categories.reorder(c, ['C', 'Nope', 'a']).order, ['C', 'A', 'B']);
  assert.equal(categories.reorder(c, 'C,A,B').ok, false);
});

test('resolve reuses the stored spelling, creates new names, and treats blank as Ungrouped', () => {
  const c = cfg(['Media']);
  assert.deepEqual(categories.resolve(c, 'media'), { ok: true, name: 'Media' });
  assert.deepEqual(categories.resolve(c, '   '), { ok: true, name: '' });

  const created = categories.resolve(c, 'New  One');
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.name, 'New One');
  assert.ok(categories.list(c).includes('New One'));

  assert.equal(categories.resolve(c, 'Ungrouped').ok, false);
});
