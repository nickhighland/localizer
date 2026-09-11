/*
 * Stacked dialogs shared by the dashboard and the admin panel.
 *
 * Escape and a click on the backdrop dismiss only the topmost dialog, so an
 * icon picker opened from an edit form never takes the form down with it.
 */

import { el } from './common.js';

const stack = [];
let sequence = 0;

// Capture phase, so the topmost dialog handles Escape before any page-level
// listener can react to it.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !stack.length) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  stack[stack.length - 1].dismiss();
}, true);

export function openDialog({
  title, sub, body = [], actions = [], className = '', form = false, onDismiss,
} = {}) {
  sequence += 1;
  const titleId = `dialog-title-${sequence}`;

  const panel = el(form ? 'form' : 'div', {
    class: `modal ${className}`.trim(),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': title ? titleId : null,
    novalidate: form ? 'novalidate' : null,
  }, [
    title ? el('h2', { id: titleId, text: title }) : null,
    sub ? el('p', { class: 'sub', text: sub }) : null,
    ...body,
    actions.length ? el('div', { class: 'modal-actions' }, actions) : null,
  ]);

  const backdrop = el('div', { class: 'modal-backdrop dialog-backdrop' }, [panel]);
  backdrop.style.zIndex = String(60 + stack.length * 10);

  const returnFocus = document.activeElement;
  let open = true;

  const handle = {
    panel,
    close() {
      if (!open) return;
      open = false;
      const index = stack.indexOf(handle);
      if (index >= 0) stack.splice(index, 1);
      backdrop.remove();
      if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) {
        returnFocus.focus({ preventScroll: true });
      }
    },
    dismiss() {
      if (!open) return;
      handle.close();
      if (onDismiss) onDismiss();
    },
  };

  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) handle.dismiss();
  });

  stack.push(handle);
  document.body.appendChild(backdrop);
  return handle;
}

function errorNotice() {
  return el('div', { class: 'notice error', role: 'alert', hidden: 'hidden' });
}

function showError(node, message) {
  node.textContent = message;
  node.hidden = false;
}

/**
 * Asks for one line of text. `onSubmit` runs before the dialog closes; if it
 * throws, the message is shown inline and the dialog stays open, so a rejected
 * name can be corrected rather than retyped. Resolves to the value, or null.
 */
export function promptDialog({
  title, message, label = 'Name', value = '', placeholder = '', confirmText = 'Save',
  maxLength = 60, onSubmit,
} = {}) {
  return new Promise((resolve) => {
    const input = el('input', {
      class: 'input', value, placeholder, maxlength: String(maxLength), autocomplete: 'off', spellcheck: 'false',
    });
    const error = errorNotice();
    const cancel = el('button', { class: 'btn', type: 'button' }, ['Cancel']);
    const confirm = el('button', { class: 'btn btn-primary', type: 'submit' }, [confirmText]);

    const dialog = openDialog({
      title,
      sub: message,
      form: true,
      className: 'dialog-sm',
      body: [error, el('label', { class: 'field' }, [el('span', { class: 'label', text: label }), input])],
      actions: [el('div', { class: 'spacer' }), cancel, confirm],
      onDismiss: () => resolve(null),
    });

    cancel.addEventListener('click', () => dialog.dismiss());

    dialog.panel.addEventListener('submit', async (event) => {
      event.preventDefault();
      const next = input.value.replace(/\s+/g, ' ').trim();
      if (!next) {
        showError(error, `${label} cannot be empty.`);
        input.focus();
        return;
      }
      if (onSubmit) {
        confirm.disabled = true;
        try {
          await onSubmit(next);
        } catch (err) {
          showError(error, err.message);
          confirm.disabled = false;
          input.focus();
          return;
        }
      }
      dialog.close();
      resolve(next);
    });

    input.focus();
    input.select();
  });
}

/** Asks for a yes. Destructive confirmations start with focus on Cancel. */
export function confirmDialog({
  title, message, confirmText = 'Confirm', danger = false, onConfirm,
} = {}) {
  return new Promise((resolve) => {
    const error = errorNotice();
    const cancel = el('button', { class: 'btn', type: 'button' }, ['Cancel']);
    const confirm = el('button', {
      class: `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`, type: 'button',
    }, [confirmText]);

    const dialog = openDialog({
      title,
      sub: message,
      className: 'dialog-sm',
      body: [error],
      actions: [el('div', { class: 'spacer' }), cancel, confirm],
      onDismiss: () => resolve(false),
    });

    cancel.addEventListener('click', () => dialog.dismiss());
    confirm.addEventListener('click', async () => {
      if (onConfirm) {
        confirm.disabled = true;
        cancel.disabled = true;
        try {
          await onConfirm();
        } catch (err) {
          showError(error, err.message);
          confirm.disabled = false;
          cancel.disabled = false;
          return;
        }
      }
      dialog.close();
      resolve(true);
    });

    (danger ? cancel : confirm).focus();
  });
}
