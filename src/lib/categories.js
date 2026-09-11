'use strict';

/**
 * Category operations over a loaded config object.
 *
 * `settings.categoryOrder` is the authoritative list: a category exists once it
 * is listed, whether or not any service uses it, so an empty group can be made
 * first and filled by dragging tiles into it. Services can still carry a
 * category that was never listed (older configs, imports); those follow the
 * listed ones, alphabetically.
 *
 * Names compare case-insensitively everywhere and keep the casing they were
 * created with, so "media" typed into a form files a tile under "Media".
 */

const MAX_LENGTH = 40;
const MAX_CATEGORIES = 40;
const RESERVED = 'ungrouped';

const key = (name) => String(name ?? '').trim().toLowerCase();

function clean(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, error: 'Category name cannot be empty.' };
  if (name.length > MAX_LENGTH) {
    return { ok: false, error: `Category names must be ${MAX_LENGTH} characters or fewer.` };
  }
  if ([...name].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) {
    return { ok: false, error: 'Category names cannot contain control characters.' };
  }
  if (key(name) === RESERVED) {
    return { ok: false, error: '"Ungrouped" is reserved for services without a category.' };
  }
  return { ok: true, name };
}

/** Every category, in display order. */
function list(cfg) {
  const seen = new Set();
  const ordered = [];
  for (const entry of cfg.settings.categoryOrder || []) {
    const name = String(entry ?? '').trim();
    if (!name || seen.has(key(name))) continue;
    seen.add(key(name));
    ordered.push(name);
  }

  const unlisted = [];
  for (const service of cfg.services) {
    const name = String(service.category || '').trim();
    if (!name || seen.has(key(name))) continue;
    seen.add(key(name));
    unlisted.push(name);
  }
  unlisted.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  return [...ordered, ...unlisted];
}

/** The stored spelling of a category, or null. */
function find(cfg, raw) {
  const wanted = key(raw);
  if (!wanted) return null;
  return list(cfg).find((name) => key(name) === wanted) || null;
}

function withCounts(cfg) {
  return list(cfg).map((name) => ({
    name,
    count: cfg.services.filter((s) => key(s.category) === key(name)).length,
  }));
}

function add(cfg, raw) {
  const result = clean(raw);
  if (!result.ok) return result;
  const existing = find(cfg, result.name);
  if (existing) return { ok: false, error: `A category named "${existing}" already exists.` };
  const current = list(cfg);
  if (current.length >= MAX_CATEGORIES) {
    return { ok: false, error: `${MAX_CATEGORIES} categories is the maximum.` };
  }
  // Writing out the full list freezes where unlisted categories currently sit,
  // so adding one never shuffles the others.
  cfg.settings.categoryOrder = [...current, result.name];
  return { ok: true, name: result.name };
}

function rename(cfg, from, to) {
  const current = find(cfg, from);
  if (!current) return { ok: false, error: `There is no category named "${String(from ?? '').trim()}".` };

  const result = clean(to);
  if (!result.ok) return result;

  const clash = find(cfg, result.name);
  if (clash && key(clash) !== key(current)) {
    return { ok: false, error: `A category named "${clash}" already exists.` };
  }

  cfg.settings.categoryOrder = list(cfg).map((name) => (key(name) === key(current) ? result.name : name));
  let moved = 0;
  for (const service of cfg.services) {
    if (key(service.category) === key(current)) {
      service.category = result.name;
      moved += 1;
    }
  }
  return { ok: true, name: result.name, previous: current, moved };
}

/** Forgets a category. Its services stay, as Ungrouped. */
function remove(cfg, raw) {
  const current = find(cfg, raw);
  if (!current) return { ok: false, error: `There is no category named "${String(raw ?? '').trim()}".` };

  cfg.settings.categoryOrder = list(cfg).filter((name) => key(name) !== key(current));
  let moved = 0;
  for (const service of cfg.services) {
    if (key(service.category) === key(current)) {
      service.category = '';
      moved += 1;
    }
  }
  return { ok: true, name: current, moved };
}

/** Applies a new order. Unknown names are ignored; anything left out keeps its place at the end. */
function reorder(cfg, order) {
  if (!Array.isArray(order)) return { ok: false, error: 'Order must be a list of category names.' };

  const known = list(cfg);
  const byKey = new Map(known.map((name) => [key(name), name]));
  const next = [];
  const seen = new Set();
  for (const entry of order) {
    const name = byKey.get(key(entry));
    if (!name || seen.has(key(name))) continue;
    seen.add(key(name));
    next.push(name);
  }
  for (const name of known) {
    if (!seen.has(key(name))) next.push(name);
  }
  cfg.settings.categoryOrder = next;
  return { ok: true, order: next };
}

/**
 * Resolves a category typed on a service to its stored spelling, creating it
 * when it is new. Blank means Ungrouped.
 */
function resolve(cfg, raw) {
  const trimmed = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return { ok: true, name: '' };
  const existing = find(cfg, trimmed);
  if (existing) return { ok: true, name: existing };
  const created = add(cfg, trimmed);
  return created.ok ? { ok: true, name: created.name, created: true } : created;
}

module.exports = {
  MAX_LENGTH, key, clean, list, find, withCounts, add, rename, remove, reorder, resolve,
};
