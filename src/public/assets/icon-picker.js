/*
 * Icon choosing, shared by the admin form and the dashboard's quick editor:
 * a searchable picker over the Community Applications catalogue, plus a compact
 * control that combines preview, library, upload and a plain URL field.
 */

import { api, el, initials, toast } from './common.js';
import { openDialog } from './dialogs.js';

let searchDebounce = null;

export function openIconPicker(onPick) {
  const searchInput = el('input', {
    class: 'input', type: 'search', placeholder: 'Search 3,700+ Unraid app icons…', autocomplete: 'off',
  });
  const results = el('div', { class: 'icon-grid' });
  const statusLine = el('p', { class: 'hint', style: 'margin:10px 0 0' });
  const refreshBtn = el('button', { class: 'btn btn-sm', type: 'button' }, ['Refresh list']);
  const cancel = el('button', { class: 'btn', type: 'button' }, ['Cancel']);

  const dialog = openDialog({
    title: 'Choose an icon',
    sub: 'Icons come from the Unraid Community Applications catalogue.',
    className: 'icon-picker',
    body: [
      el('div', { style: 'display:flex;gap:10px;align-items:center' }, [searchInput, refreshBtn]),
      results,
      statusLine,
    ],
    actions: [el('div', { class: 'spacer' }), cancel],
  });
  cancel.addEventListener('click', () => dialog.close());

  async function run(query) {
    statusLine.textContent = 'Searching…';
    try {
      const data = await api(`/api/icons?q=${encodeURIComponent(query)}&limit=60`);
      results.replaceChildren();
      if (!data.results.length) {
        statusLine.textContent = query ? `No icons match “${query}”.` : 'No icons available.';
        return;
      }
      for (const item of data.results) {
        const cell = el('button', {
          class: 'icon-cell', type: 'button', title: `${item.name}${item.repo ? ` — ${item.repo}` : ''}`,
        }, [
          el('img', {
            src: item.icon,
            alt: '',
            loading: 'lazy',
            onerror: (event) => { event.target.closest('.icon-cell')?.remove(); },
          }),
          el('span', { class: 'icon-cell-name', text: item.name }),
          el('span', { class: 'icon-cell-repo', text: item.repo || '' }),
        ]);
        cell.addEventListener('click', () => {
          dialog.close();
          onPick(item);
        });
        results.appendChild(cell);
      }
      const age = data.fetchedAt ? new Date(data.fetchedAt).toLocaleDateString() : 'unknown';
      statusLine.textContent = `${data.total} match${data.total === 1 ? '' : 'es'} · app list updated ${age}`;
    } catch (err) {
      results.replaceChildren();
      statusLine.textContent = err.message;
    }
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => run(searchInput.value.trim()), 180);
  });

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing…';
    try {
      const data = await api('/api/icons/refresh', { method: 'POST' });
      toast(`Loaded ${data.count} app icons`, 'ok');
      await run(searchInput.value.trim());
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh list';
    }
  });

  searchInput.focus();
  run('');
}

/**
 * Preview, "Browse library", "Upload…", "Clear" and a URL field. Icons picked
 * from the library are copied into Localizer's own storage, so a tile keeps its
 * picture if the original host disappears.
 */
export function iconControl({
  value = '', getName = () => '', getColor = () => '#4f8cff', onPick,
} = {}) {
  const input = el('input', {
    class: 'input', value, placeholder: 'https://…/icon.png', spellcheck: 'false', autocomplete: 'off',
  });
  const preview = el('div', { class: 'icon-preview', 'aria-hidden': 'true' });
  const fileInput = el('input', { type: 'file', accept: 'image/*', hidden: 'hidden' });

  function repaint() {
    const url = input.value.trim();
    if (url) {
      preview.style.background = 'transparent';
      preview.replaceChildren(el('img', {
        src: url,
        alt: '',
        onerror: () => {
          preview.style.background = 'var(--surface-3)';
          preview.replaceChildren(el('span', { text: '!' }));
        },
      }));
    } else {
      preview.style.background = getColor();
      preview.replaceChildren(el('span', { text: initials(getName() || '?') }));
    }
  }
  input.addEventListener('input', repaint);

  const browse = el('button', { class: 'btn btn-sm', type: 'button' }, ['Browse library']);
  browse.addEventListener('click', () => {
    openIconPicker(async (picked) => {
      input.value = picked.icon;
      repaint();
      if (onPick) onPick(picked);
      try {
        const saved = await api('/api/icons/cache', { method: 'POST', body: { url: picked.icon } });
        input.value = saved.path;
        repaint();
      } catch {
        /* offline or blocked — the remote URL still works */
      }
    });
  });

  const uploadBtn = el('button', { class: 'btn btn-sm', type: 'button' }, ['Upload…']);
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading…';
    try {
      const res = await fetch('/api/icons/upload', {
        method: 'POST',
        headers: { 'content-type': file.type },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      input.value = data.path;
      repaint();
      toast('Icon uploaded', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      fileInput.value = '';
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload…';
    }
  });

  const clearBtn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: 'Show initials instead' }, ['Clear']);
  clearBtn.addEventListener('click', () => {
    input.value = '';
    repaint();
    input.focus();
  });

  const node = el('div', { class: 'icon-control' }, [
    el('div', { class: 'icon-control-top' }, [preview, browse, uploadBtn, clearBtn, fileInput]),
    input,
  ]);
  repaint();

  return {
    node,
    input,
    repaint,
    get value() { return input.value.trim(); },
  };
}
