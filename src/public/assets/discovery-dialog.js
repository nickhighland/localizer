/*
 * "Refresh from Unraid": asks the server to compare the configured tiles with
 * the containers Docker reports, shows the differences, and applies only what
 * is ticked. Opened from both the dashboard and the admin panel.
 */

import { api, el, initials, toast } from './common.js';
import { openDialog } from './dialogs.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function thumb(icon, name) {
  const box = el('div', { class: 'disc-icon', 'aria-hidden': 'true' });
  if (icon) {
    box.appendChild(el('img', {
      src: icon,
      alt: '',
      loading: 'lazy',
      onerror: () => box.replaceChildren(el('span', { text: initials(name) })),
    }));
  } else {
    box.appendChild(el('span', { text: initials(name) }));
  }
  return box;
}

function checkRow({
  group, value, checked, icon, title, badge, detail,
}) {
  return el('label', { class: 'disc-row' }, [
    el('input', {
      type: 'checkbox', 'data-group': group, value, checked: checked ? 'checked' : null,
    }),
    icon,
    el('div', { class: 'disc-main' }, [
      el('div', { class: 'disc-title' }, [
        el('strong', { text: title }),
        badge ? el('span', { class: 'badge off', text: badge }) : null,
      ]),
      el('div', { class: 'disc-detail', text: detail }),
    ]),
  ]);
}

function staticRow({ title, badge, detail }) {
  return el('div', { class: 'disc-row disc-row-static' }, [
    el('div', { class: 'disc-main' }, [
      el('div', { class: 'disc-title' }, [
        el('strong', { text: title }),
        badge ? el('span', { class: 'badge off', text: badge }) : null,
      ]),
      el('div', { class: 'disc-detail', text: detail }),
    ]),
  ]);
}

function section(title, hint, rows) {
  if (!rows.length) return null;
  return el('div', { class: 'disc-section' }, [
    el('div', { class: 'disc-head' }, [
      el('h3', { text: `${title} · ${rows.length}` }),
      hint ? el('span', { class: 'hint', text: hint }) : null,
    ]),
    el('div', { class: 'disc-list' }, rows),
  ]);
}

export function openDiscovery({ onApplied } = {}) {
  const body = el('div', { class: 'discovery' });
  const rescan = el('button', { class: 'btn btn-ghost', type: 'button' }, ['Scan again']);
  const close = el('button', { class: 'btn', type: 'button' }, ['Close']);
  const apply = el('button', { class: 'btn btn-primary', type: 'button', disabled: 'disabled' }, ['Apply changes']);

  const dialog = openDialog({
    title: 'Refresh from Unraid',
    sub: 'Compares your tiles with the containers Docker reports right now. Nothing changes until you apply.',
    className: 'discovery-dialog',
    body: [body],
    actions: [rescan, el('div', { class: 'spacer' }), close, apply],
  });

  const syncApply = () => {
    apply.disabled = !body.querySelector('input[data-group]:checked');
  };

  close.addEventListener('click', () => dialog.close());
  rescan.addEventListener('click', () => run());
  body.addEventListener('change', syncApply);

  function showUnavailable(data) {
    apply.onclick = null;
    body.replaceChildren(
      el('div', { class: 'notice info' }, [el('strong', { text: 'Localizer cannot see Docker yet.' })]),
      el('p', {
        class: 'disc-detail',
        text: 'Discovery reads the Docker socket. Map it into the container, read-only, and restart Localizer:',
      }),
      el('pre', { class: 'code-block', text: `${data.socket}  →  ${data.socket}   (read only)` }),
      el('p', {
        class: 'hint',
        text: 'On Unraid: edit the container, choose “Add another Path, Port, Variable, Label or Device”, '
          + 'pick Path, and set both paths to /var/run/docker.sock with access mode Read Only. '
          + 'Localizer only ever reads from it — but anything holding the socket can control Docker, '
          + 'and a read-only mount does not change that.',
      }),
    );
    syncApply();
  }

  function render(data, categoryNames) {
    const suffix = data.suffix || 'local';

    const addRows = data.added.map((item) => checkRow({
      group: 'add',
      value: item.container,
      checked: true,
      icon: thumb(item.icon, item.name),
      title: item.name,
      badge: item.state !== 'running' ? item.state : '',
      detail: `${item.hostname}.${suffix}  →  ${item.scheme}://${item.host}:${item.port}`,
    }));

    const removeRows = data.removed.map((item) => checkRow({
      group: 'remove',
      value: item.id,
      checked: true,
      icon: thumb('', item.name),
      title: item.name,
      detail: `Container “${item.container}” no longer exists in Docker.`,
    }));

    const updateRows = data.changed.map((item) => checkRow({
      group: 'update',
      value: item.id,
      checked: false,
      icon: thumb('', item.name),
      title: item.name,
      detail: `Docker now reports ${item.to.host}:${item.to.port} · the tile points at ${item.from.host}:${item.from.port}`,
    }));

    const attentionRows = data.warnings.map((item) => staticRow({
      title: item.name,
      detail: `${item.container} — ${item.reason}`,
    }));

    const skippedRows = data.skipped.map((item) => staticRow({
      title: item.container,
      badge: item.state !== 'running' ? item.state : '',
      detail: item.reason,
    }));

    const pending = addRows.length + removeRows.length + updateRows.length;

    const categorySelect = el('select', { class: 'select select-sm', 'aria-label': 'Category for new tiles' }, [
      el('option', { value: '', text: 'Ungrouped' }),
      ...categoryNames.map((name) => el('option', { value: name, text: name })),
    ]);

    const addSection = section('New in Unraid', null, addRows);
    if (addSection) {
      addSection.querySelector('.disc-head').appendChild(
        el('label', { class: 'disc-category' }, [el('span', { text: 'Add to' }), categorySelect]),
      );
    }

    const nodes = [
      el('p', {
        class: 'disc-summary',
        text: [
          `${data.added.length} new`,
          `${data.removed.length} gone`,
          `${data.changed.length} moved`,
          `${data.unchanged} up to date`,
        ].join(' · '),
      }),
      pending ? null : el('div', { class: 'disc-uptodate' }, [
        el('strong', { text: 'Everything matches Unraid.' }),
        el('span', { text: ` ${plural(data.unchanged, 'tile')} linked to containers.` }),
      ]),
      addSection,
      section('Gone from Unraid', 'Removes the tile — nothing in Docker is touched.', removeRows),
      section('Moved', 'Unticked by default, in case you set the port yourself.', updateRows),
      section('Needs attention', null, attentionRows),
      skippedRows.length ? el('details', { class: 'disc-skipped' }, [
        el('summary', { text: `${plural(skippedRows.length, 'container')} with no reachable web UI` }),
        el('div', { class: 'disc-list' }, skippedRows),
      ]) : null,
    ];

    body.replaceChildren(...nodes.filter(Boolean));
    syncApply();

    apply.onclick = async () => {
      const values = (group) => [...body.querySelectorAll(`input[data-group="${group}"]:checked`)]
        .map((box) => box.value);
      apply.disabled = true;
      apply.textContent = 'Applying…';
      try {
        const result = await api('/api/discovery/apply', {
          method: 'POST',
          body: {
            add: values('add'),
            remove: values('remove'),
            update: values('update'),
            category: categorySelect.value,
          },
        });
        const parts = [];
        if (result.added.length) parts.push(`added ${result.added.length}`);
        if (result.removed.length) parts.push(`removed ${result.removed.length}`);
        if (result.updated.length) parts.push(`updated ${result.updated.length}`);
        for (const message of result.errors || []) toast(message, 'error');
        toast(parts.length ? `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}.` : 'Nothing changed.', 'ok');
        dialog.close();
        if (onApplied) await onApplied(result);
      } catch (err) {
        toast(err.message, 'error');
        apply.textContent = 'Apply changes';
        syncApply();
      }
    };
  }

  async function run() {
    apply.disabled = true;
    rescan.disabled = true;
    body.replaceChildren(el('p', { class: 'hint', text: 'Asking Docker what is on this server…' }));
    try {
      const [data, cats] = await Promise.all([api('/api/discovery'), api('/api/categories')]);
      if (!data.available) showUnavailable(data);
      else render(data, (cats.categories || []).map((c) => c.name));
    } catch (err) {
      body.replaceChildren(el('div', { class: 'notice error', text: err.message }));
    } finally {
      rescan.disabled = false;
    }
  }

  run();
  return dialog;
}
