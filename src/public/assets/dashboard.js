import {
  api, el, initials, mountBrand, statusLabel, toast, SEARCH_SVG, PENCIL_SVG, TRASH_SVG,
} from './common.js';
import { openDialog, promptDialog, confirmDialog } from './dialogs.js';
import { iconControl } from './icon-picker.js';
import { openDiscovery } from './discovery-dialog.js';

const content = document.getElementById('content');
const search = document.getElementById('search');
const foot = document.getElementById('foot');
const newTabToggle = document.getElementById('newTabToggle');
const sortSelect = document.getElementById('sortSelect');
const addCategoryBtn = document.getElementById('addCategoryBtn');
const discoverBtn = document.getElementById('discoverBtn');

document.getElementById('searchIcon').outerHTML = SEARCH_SVG;

const state = {
  services: [],
  categories: [],
  appearance: {},
  sort: 'manual',
  canEdit: false,
};

const UNGROUPED = 'Ungrouped';
const NEW_CATEGORY = '__new_category__';
const key = (name) => String(name || '').trim().toLowerCase();

// ---------- per-browser preferences ----------
// Storage can be unavailable (private windows, blocked site data); none of this
// is essential, so every access is guarded.

function readPref(name) {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

function writePref(name, value) {
  try {
    localStorage.setItem(name, value);
  } catch { /* not essential */ }
}

let openInNewTab = readPref('urp:newTab') !== 'false';
const collapsed = new Set((() => {
  try {
    return JSON.parse(readPref('urp:collapsed') || '[]');
  } catch {
    return [];
  }
})());

const saveCollapsed = () => writePref('urp:collapsed', JSON.stringify([...collapsed]));

function syncToggle() {
  newTabToggle.textContent = openInNewTab ? '↗ New tab' : '→ Same tab';
  newTabToggle.title = openInNewTab
    ? 'Links open in a new tab — click to change'
    : 'Links open in this tab — click to change';
}

newTabToggle.addEventListener('click', () => {
  openInNewTab = !openInNewTab;
  writePref('urp:newTab', String(openInNewTab));
  syncToggle();
  render();
});

// ---------- appearance ----------

function applyAppearance() {
  const a = state.appearance || {};
  const root = document.documentElement;

  if (a.accent) {
    root.style.setProperty('--accent', a.accent);
    root.style.setProperty('--accent-soft', `color-mix(in srgb, ${a.accent} 14%, transparent)`);
  }
  if (a.theme && a.theme !== 'auto') root.dataset.theme = a.theme;
  else root.removeAttribute('data-theme');
  root.dataset.density = a.density || 'comfortable';
  root.dataset.layout = a.layout || 'grid';
  root.dataset.background = a.background || 'aurora';
}

// ---------- tiles ----------

function tile(service) {
  const a = state.appearance || {};
  const draggable = state.canEdit && state.sort === 'manual';

  const icon = service.icon
    ? el('div', { class: 'tile-icon' }, [el('img', { src: service.icon, alt: '', loading: 'lazy' })])
    : el('div', { class: 'tile-icon', text: initials(service.name) });

  const status = service.status ? (service.status.up ? 'up' : 'down') : 'unknown';

  const body = [el('div', { class: 'tile-name', text: service.name })];
  if (a.showHostnames !== false) {
    body.push(el('div', { class: 'tile-host', text: service.fqdn }));
  }
  if (a.showDescriptions !== false && service.description) {
    body.push(el('div', { class: 'tile-desc', text: service.description }));
  }

  const link = el('a', {
    class: 'tile',
    href: service.url,
    style: `--tile-color:${service.color}`,
    target: openInNewTab ? '_blank' : null,
    rel: openInNewTab ? 'noopener' : null,
    'data-id': service.id,
    draggable: draggable ? 'true' : null,
    title: statusLabel(service.status),
  }, [
    icon,
    el('div', { class: 'tile-body' }, body),
    a.showStatus !== false ? el('span', { class: `dot ${status} tile-status` }) : null,
  ]);

  if (draggable) attachDrag(link, service);
  if (!state.canEdit) return el('div', { class: 'tile-wrap' }, [link]);

  // A sibling of the link, not a child: a button inside <a> is invalid HTML,
  // and a click on it would follow the link instead of opening the editor.
  const edit = el('button', {
    class: 'tile-edit',
    type: 'button',
    title: `Edit ${service.name}`,
    'aria-label': `Edit ${service.name}`,
    html: PENCIL_SVG,
  });
  edit.addEventListener('click', () => openQuickEdit(service));

  return el('div', { class: 'tile-wrap editable' }, [link, edit]);
}

// ---------- drag to arrange ----------

let dragging = null;

function clearDropHints() {
  for (const n of content.querySelectorAll('.drop-before, .drop-after, .group-drop')) {
    n.classList.remove('drop-before', 'drop-after', 'group-drop');
  }
}

function attachDrag(node, service) {
  node.addEventListener('dragstart', (event) => {
    dragging = service;
    node.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    // Without this an <a> drag offers its href, which browsers prefer.
    event.dataTransfer.setData('text/plain', service.id);
    // Deferred: changing the page during dragstart can cancel the drag.
    setTimeout(() => document.body.classList.add('is-dragging'), 0);
  });
  node.addEventListener('dragend', () => {
    dragging = null;
    node.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    clearDropHints();
  });
  node.addEventListener('dragover', (event) => {
    if (!dragging || dragging.id === service.id) return;
    event.preventDefault();
    event.stopPropagation();
    const box = node.getBoundingClientRect();
    const after = (event.clientX - box.left) > box.width / 2;
    node.classList.toggle('drop-after', after);
    node.classList.toggle('drop-before', !after);
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-before', 'drop-after'));
  node.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const after = node.classList.contains('drop-after');
    clearDropHints();
    if (!dragging || dragging.id === service.id) return;
    moveService(dragging, service.category || '', service.id, after);
  });
}

/** A whole group is a drop target too, so an empty group still accepts tiles. */
function attachGroupDrop(node, category) {
  node.addEventListener('dragover', (event) => {
    if (!dragging) return;
    event.preventDefault();
    node.classList.add('group-drop');
  });
  node.addEventListener('dragleave', (event) => {
    if (!node.contains(event.relatedTarget)) node.classList.remove('group-drop');
  });
  node.addEventListener('drop', (event) => {
    event.preventDefault();
    clearDropHints();
    if (!dragging) return;
    moveService(dragging, category, null, true);
  });
}

async function moveService(moved, category, anchorId, after) {
  const list = state.services.filter((s) => s.id !== moved.id);
  moved.category = category;

  let index;
  if (anchorId) {
    const at = list.findIndex((s) => s.id === anchorId);
    index = at < 0 ? list.length : (after ? at + 1 : at);
  } else {
    // Dropped on a group rather than a tile: append to that group.
    const last = list.map((s) => key(s.category)).lastIndexOf(key(category));
    index = last < 0 ? list.length : last + 1;
  }
  list.splice(index, 0, moved);
  state.services = list;
  render();

  try {
    await api('/api/services/order', {
      method: 'POST',
      body: {
        ids: state.services.map((s) => s.id),
        categories: { [moved.id]: category },
      },
    });
  } catch (err) {
    toast(err.message, 'error');
    load();
  }
}

// ---------- categories ----------

async function addCategory() {
  const name = await promptDialog({
    title: 'New category',
    message: 'Create an empty group, then drag tiles into it.',
    label: 'Category name',
    placeholder: 'e.g. Media',
    confirmText: 'Create',
    maxLength: 40,
    onSubmit: (value) => api('/api/categories', { method: 'POST', body: { name: value } }),
  });
  if (!name) return;
  await load();
  toast(`Created ${name}`, 'ok');
}

async function renameCategory(name) {
  const next = await promptDialog({
    title: 'Rename category',
    label: 'Category name',
    value: name,
    confirmText: 'Rename',
    maxLength: 40,
    onSubmit: async (value) => {
      if (value === name) return;
      await api('/api/categories/rename', { method: 'POST', body: { from: name, to: value } });
    },
  });
  if (next === null || next === name) return;
  if (collapsed.delete(name)) {
    collapsed.add(next);
    saveCollapsed();
  }
  await load();
  toast(`Renamed to ${next}`, 'ok');
}

async function deleteCategory(name, count) {
  const confirmed = await confirmDialog({
    title: `Delete “${name}”?`,
    message: count
      ? `Its ${count} tile${count === 1 ? '' : 's'} move to Ungrouped. No service is removed.`
      : 'There is nothing in it.',
    confirmText: 'Delete category',
    danger: true,
    onConfirm: () => api('/api/categories/delete', { method: 'POST', body: { name } }),
  });
  if (!confirmed) return;
  if (collapsed.delete(name)) saveCollapsed();
  await load();
  toast(`Deleted ${name}`);
}

// ---------- quick edit ----------

function field(label, control) {
  return el('label', { class: 'field' }, [el('span', { class: 'label', text: label }), control]);
}

// Not a <label>: clicking anywhere in a label activates its first control, and
// the icon control holds several buttons.
function fieldGroup(label, control) {
  return el('div', { class: 'field' }, [el('span', { class: 'label', text: label }), control]);
}

function openQuickEdit(service) {
  const nameInput = el('input', {
    class: 'input', value: service.name, maxlength: '60', autocomplete: 'off',
  });
  const icon = iconControl({
    value: service.icon,
    getName: () => nameInput.value,
    getColor: () => service.color,
  });
  nameInput.addEventListener('input', () => {
    if (!icon.value) icon.repaint();
  });

  const categorySelect = el('select', { class: 'select' });
  let lastCategory = '';

  function fillCategories(selected) {
    categorySelect.replaceChildren(
      el('option', { value: '', text: UNGROUPED }),
      ...state.categories.map((name) => el('option', { value: name, text: name })),
      el('option', { value: NEW_CATEGORY, text: '＋ New category…' }),
    );
    categorySelect.value = state.categories.find((name) => key(name) === key(selected)) || '';
    lastCategory = categorySelect.value;
  }
  fillCategories(service.category);

  categorySelect.addEventListener('change', async () => {
    if (categorySelect.value !== NEW_CATEGORY) {
      lastCategory = categorySelect.value;
      return;
    }
    const created = await promptDialog({
      title: 'New category',
      label: 'Category name',
      placeholder: 'e.g. Media',
      confirmText: 'Create',
      maxLength: 40,
      onSubmit: async (value) => {
        const result = await api('/api/categories', { method: 'POST', body: { name: value } });
        state.categories = result.categories.map((c) => c.name);
      },
    });
    fillCategories(created || lastCategory);
  });

  const error = el('div', { class: 'notice error', role: 'alert', hidden: 'hidden' });
  const cancel = el('button', { class: 'btn', type: 'button' }, ['Cancel']);
  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, ['Save']);
  const more = el('a', { class: 'btn btn-ghost', href: `/admin#service-${service.id}` }, ['All settings']);

  const dialog = openDialog({
    title: `Edit ${service.name}`,
    sub: service.fqdn,
    form: true,
    className: 'quick-edit',
    body: [error, field('Name', nameInput), fieldGroup('Icon', icon.node), field('Category', categorySelect)],
    actions: [more, el('div', { class: 'spacer' }), cancel, save],
  });
  cancel.addEventListener('click', () => dialog.close());

  dialog.panel.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = nameInput.value.replace(/\s+/g, ' ').trim();
    if (!name) {
      error.textContent = 'Name cannot be empty.';
      error.hidden = false;
      nameInput.focus();
      return;
    }
    save.disabled = true;
    try {
      await api(`/api/services/${service.id}`, {
        method: 'PUT',
        body: { name, icon: icon.value, category: lastCategory },
      });
      dialog.close();
      await load();
      toast(`Saved ${name}`, 'ok');
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      save.disabled = false;
    }
  });

  nameInput.focus();
  nameInput.select();
}

// ---------- grouping & sorting ----------

function sorted(list) {
  const copy = [...list];
  if (state.sort === 'name') {
    copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } else if (state.sort === 'status') {
    const rank = (s) => (s.status ? (s.status.up ? 0 : 1) : 2);
    copy.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }
  return copy;
}

function groupHeading(category, count) {
  const label = category || UNGROUPED;
  const storeKey = category || UNGROUPED;
  const isCollapsed = collapsed.has(storeKey);

  const toggle = el('button', {
    class: 'group-toggle',
    type: 'button',
    'aria-expanded': String(!isCollapsed),
  }, [
    el('span', { class: 'group-caret', text: '▾', 'aria-hidden': 'true' }),
    el('span', { class: 'group-name', text: label }),
    el('span', { class: 'group-count', text: String(count) }),
  ]);
  toggle.addEventListener('click', () => {
    if (collapsed.has(storeKey)) collapsed.delete(storeKey);
    else collapsed.add(storeKey);
    saveCollapsed();
    render();
  });

  const parts = [toggle, el('span', { class: 'group-rule', 'aria-hidden': 'true' })];

  if (state.canEdit && category) {
    const renameBtn = el('button', {
      class: 'icon-btn', type: 'button', title: `Rename ${category}`, 'aria-label': `Rename ${category}`, html: PENCIL_SVG,
    });
    renameBtn.addEventListener('click', () => renameCategory(category));
    const deleteBtn = el('button', {
      class: 'icon-btn danger', type: 'button', title: `Delete ${category}`, 'aria-label': `Delete ${category}`, html: TRASH_SVG,
    });
    deleteBtn.addEventListener('click', () => deleteCategory(category, count));
    parts.push(el('span', { class: 'group-actions' }, [renameBtn, deleteBtn]));
  }

  return el('div', { class: `group-head${isCollapsed ? ' collapsed' : ''}` }, parts);
}

function groupSection(category, list, { slot = false } = {}) {
  const editing = state.canEdit && state.sort === 'manual';
  const storeKey = category || UNGROUPED;
  const section = el('section', { class: `group${slot ? ' group-slot' : ''}` });
  section.appendChild(groupHeading(category, list.length));

  if (slot || !collapsed.has(storeKey)) {
    if (list.length) {
      const grid = el('div', { class: 'grid' });
      for (const s of list) grid.appendChild(tile(s));
      section.appendChild(grid);
    } else {
      let hint = 'Empty';
      if (slot) hint = 'Drop a tile here to take it out of its category';
      else if (editing) hint = 'Empty — drag tiles here';
      section.appendChild(el('div', { class: 'group-empty', text: hint }));
    }
  }

  if (editing) attachGroupDrop(section, category);
  return section;
}

function emptyState() {
  const actions = [el('a', { class: 'btn btn-primary', href: '/admin' }, ['Open the admin panel'])];
  if (state.canEdit) {
    const scan = el('button', { class: 'btn', type: 'button' }, ['Find containers in Unraid']);
    scan.addEventListener('click', () => openDiscovery({ onApplied: load }));
    actions.unshift(scan);
  }
  return el('div', { class: 'empty' }, [
    el('h3', { text: 'No services yet' }),
    el('p', { text: 'Map your first container to a .local address and it will show up here.' }),
    el('div', { class: 'empty-actions' }, actions),
  ]);
}

function render() {
  const term = search.value.trim().toLowerCase();
  content.replaceChildren();

  if (!state.services.length && !state.categories.length) {
    content.appendChild(emptyState());
    return;
  }

  const matches = term
    ? state.services.filter((s) => `${s.name} ${s.fqdn} ${s.description || ''} ${s.category || ''}`
      .toLowerCase().includes(term))
    : state.services;

  if (term && !matches.length) {
    content.appendChild(el('div', { class: 'empty' }, [
      el('h3', { text: 'Nothing matches' }),
      el('p', { text: `No service matches “${search.value.trim()}”.` }),
    ]));
    return;
  }

  // Searching flattens the view — groups get in the way of finding one thing.
  // With no categories at all, a lone "Ungrouped" heading would be noise.
  const grouping = state.appearance.groupByCategory !== false && !term && state.categories.length > 0;
  if (!grouping) {
    if (!matches.length) {
      content.appendChild(emptyState());
      return;
    }
    const grid = el('div', { class: 'grid' });
    for (const s of sorted(matches)) grid.appendChild(tile(s));
    content.appendChild(grid);
    return;
  }

  for (const category of state.categories) {
    const inGroup = sorted(matches.filter((s) => key(s.category) === key(category)));
    if (!inGroup.length && !state.canEdit) continue;
    content.appendChild(groupSection(category, inGroup));
  }

  const known = new Set(state.categories.map(key));
  const loose = sorted(matches.filter((s) => !known.has(key(s.category))));
  if (loose.length) {
    content.appendChild(groupSection('', loose));
  } else if (state.canEdit && state.sort === 'manual') {
    // Only shown mid-drag, so a tile can be dropped out of its category.
    content.appendChild(groupSection('', [], { slot: true }));
  }
}

// ---------- data ----------

async function load() {
  const data = await api('/api/dashboard');
  state.services = data.services || [];
  state.categories = data.categories || [];
  state.appearance = data.appearance || {};
  state.sort = data.sort || 'manual';
  state.canEdit = Boolean(data.canEdit);

  const title = data.title || 'Localizer';
  document.title = title;
  let subtitle = title === 'Localizer' ? 'Your services' : 'Localizer';
  if (state.canEdit) subtitle = 'Drag tiles to arrange them · pencil to edit';
  mountBrand(document.getElementById('brand'), title, subtitle);

  sortSelect.value = state.sort;
  sortSelect.hidden = false;
  addCategoryBtn.hidden = !state.canEdit;
  discoverBtn.hidden = !state.canEdit;

  applyAppearance();
  render();

  const n = state.services.length;
  foot.textContent = n ? `${n} service${n === 1 ? '' : 's'}` : '';
}

sortSelect.addEventListener('change', async () => {
  state.sort = sortSelect.value;
  render();
  if (!state.canEdit) return;
  try {
    const current = await api('/api/settings');
    await api('/api/settings', {
      method: 'PUT',
      body: { ...current.settings, dashboardSort: state.sort },
    });
  } catch {
    /* the view already changed; persisting the preference is a nicety */
  }
});

addCategoryBtn.addEventListener('click', addCategory);
discoverBtn.addEventListener('click', () => openDiscovery({ onApplied: load }));

async function refreshStatus() {
  try {
    const { status } = await api('/api/status');
    let changed = false;
    for (const service of state.services) {
      const next = status[service.id] || null;
      const before = service.status ? service.status.up : null;
      service.status = next;
      if ((next ? next.up : null) !== before) changed = true;
    }
    // Never re-render under an open dialog or an active drag.
    if (changed && !dragging && !document.querySelector('.dialog-backdrop')) render();
  } catch {
    /* transient; the next tick will retry */
  }
}

search.addEventListener('input', render);
search.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    search.value = '';
    render();
    search.blur();
  }
  if (event.key === 'Enter') {
    const first = content.querySelector('.tile');
    if (first) first.click();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || document.activeElement === search) return;
  if (event.target.closest && event.target.closest('input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  search.focus();
  search.select();
});

async function init() {
  syncToggle();
  try {
    const session = await api('/api/session');
    if (!session.authenticated) {
      const link = document.getElementById('adminLink');
      link.textContent = 'Sign in';
      link.href = '/login?next=/';
    }
  } catch { /* the dashboard still renders */ }

  try {
    await load();
  } catch (err) {
    content.replaceChildren(el('div', { class: 'notice error', text: err.message }));
    return;
  }
  setInterval(refreshStatus, 30_000);
}

init();
