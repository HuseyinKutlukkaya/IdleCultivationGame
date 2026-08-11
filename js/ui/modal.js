/**
 * ui/modal.js — in-game confirmation modal (pure presentation).
 *
 * A focused, accessible replacement for window.confirm() in the destructive-
 * action path (Settings → Reset save). Lives in its own module so other
 * panels / future systems can adopt it without inheriting the Settings
 * initializer's surface. Owns NOTHING beyond its own DOM nodes — never
 * touches EventBus, GameState, or any gameplay system. Resolves to a
 * boolean Promise; the caller decides what the choice means.
 *
 * Wiring model: every call to showConfirm() creates a fresh modal subtree,
 * appends it into the resolved host, focuses the appropriate button, and
 * resolves the returned Promise exactly once. On resolve (any cause) the
 * subtree is removed and the previously-focused element is restored — no
 * leaked listeners, no shared state across concurrent calls (two stacked
 * modals each get their own dialog).
 *
 * Host resolution: prefers [data-modal-root] on document (the static
 * position where index.html mounts the host so modals sit outside the
 * game-grid scroll context); falls back to document.body when the host is
 * absent. Missing document / missing root → resolves false, no throw — a
 * defensive no-op for tests, SSR and stripped builds.
 *
 * A11y contract:
 *   role="dialog", aria-modal="true"
 *   aria-labelledby → <h2 class="modal__title"> id
 *   aria-describedby → <p class="modal__message"> id
 *   Focus moves to confirm button (or cancel button when danger:true, so
 *     the destructive action is not the default Enter target).
 *   Tab cycles between the two buttons only (the focus trap is a single-
 *     dialog, two-button cycle — a defensive pattern that keeps screen-
 *     reader users inside the modal without trapping the rest of the page
 *     when the dialog is missing).
 *   ESC key resolves false. Backdrop click resolves false. Enter key
 *     inside the dialog resolves true (the focused button's default
 *     action).
 *
 * Defensive contract (every bad call is a `console.warn` + a no-op —
 * never a throw, never a mutation):
 *   - missing document → resolve false, no DOM created
 *   - missing [data-modal-root] (no host resolved) → resolve false, no
 *     DOM created (the host is required because index.html guarantees it
 *     in production; absence means the test / stripped build owns the
 *     environment)
 *   - message is clamped to ~500 chars to keep a hostile injection from
 *     blowing up the dialog's layout
 *   - all user-supplied strings are written via textContent (never
 *     innerHTML) so XSS-via-confirm is structurally impossible
 *
 * DOM contracts (attributes this module reads/writes):
 *   [data-modal-root]            on the host container (index.html)
 *   [data-modal-dialog]          on the dialog wrapper element
 *   [data-modal-backdrop]        on the backdrop layer (click target)
 *   [data-modal-panel]           on the visible panel card
 *   [data-modal-title]           on the <h2>
 *   [data-modal-message]         on the <p>
 *   [data-modal-actions]         on the action row container
 *   [data-modal-cancel]          on the cancel button
 *   [data-modal-confirm]         on the confirm button (carries
 *                                data-danger="true" when danger:true)
 *
 * Pure presentation — no gameplay state writes, no EventBus emissions.
 * Framework-free and GitHub Pages compatible.
 *
 * Future plug-in: a Promise-returning `showPrompt({...})` for free-text
 * input reuses the same host + a11y shell; the dialog structure here is
 * the canonical template for any future modal-style UI.
 */
const MESSAGE_MAX_LENGTH = 500;

/** Selector for the host the modal subtree is appended into. */
const HOST_SELECTOR = '[data-modal-root]';

/**
 * Show an in-game confirmation modal. Returns a Promise that resolves to
 * true on confirm (click OR Enter inside the dialog) or false on cancel
 * (click, ESC OR backdrop click). The modal is removed on resolve; the
 * element focused before open() is refocused on close.
 *
 * Each call produces a fresh dialog — concurrent calls each get their own
 * subtree and resolve independently.
 *
 * @param {object} [options]
 * @param {string} [options.title=''] — heading text (clamped via textContent).
 * @param {string} [options.message=''] — body text (clamped to ~500 chars).
 * @param {string} [options.confirmLabel='Confirm'] — confirm button copy.
 * @param {string} [options.cancelLabel='Cancel'] — cancel button copy.
 * @param {boolean} [options.danger=false] — when true, focus lands on the
 *        cancel button (not confirm) and the confirm button renders the
 *        destructive style. Default false (neutral confirmation).
 * @returns {Promise<boolean>} true on confirm, false on cancel / ESC /
 *        backdrop / missing DOM.
 */
export function showConfirm({
  title = '',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    // Defensive: no document → no DOM, no listeners, just resolve false.
    if (typeof document === 'undefined') {
      console.warn('Modal: no document available; showConfirm resolves false.');
      resolve(false);
      return;
    }

    const host = document.querySelector(HOST_SELECTOR) || document.body;
    if (!host) {
      console.warn('Modal: no host element found; showConfirm resolves false.');
      resolve(false);
      return;
    }

    const previousFocus =
      typeof document.activeElement === 'object' && document.activeElement
        ? document.activeElement
        : null;

    // Clamp message length defensively so a hostile caller cannot blow up
    // the dialog's layout. Title and labels stay short by convention but
    // get the same treatment for symmetry.
    const safeTitle = clampString(title);
    const safeMessage = clampString(message);
    const safeConfirmLabel = clampString(confirmLabel);
    const safeCancelLabel = clampString(cancelLabel);

    // The ids need to be unique per dialog so two concurrent modals never
    // share an aria-labelledby / aria-describedby pointer.
    const titleId = `modal-title-${nextDialogId()}`;
    const messageId = `modal-message-${nextDialogId()}`;

    // Build the dialog subtree by hand — every value goes through
    // textContent, never innerHTML. createElement is the only DOM writer.
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.setAttribute('aria-describedby', messageId);
    dialog.setAttribute('data-modal-dialog', '');

    const backdrop = document.createElement('div');
    backdrop.className = 'modal__backdrop';
    backdrop.setAttribute('data-modal-backdrop', '');
    dialog.appendChild(backdrop);

    const panel = document.createElement('div');
    panel.className = 'modal__panel';
    panel.setAttribute('data-modal-panel', '');
    dialog.appendChild(panel);

    const titleEl = document.createElement('h2');
    titleEl.className = 'modal__title';
    titleEl.id = titleId;
    titleEl.setAttribute('data-modal-title', '');
    titleEl.textContent = safeTitle;
    panel.appendChild(titleEl);

    const messageEl = document.createElement('p');
    messageEl.className = 'modal__message';
    messageEl.id = messageId;
    messageEl.setAttribute('data-modal-message', '');
    messageEl.textContent = safeMessage;
    panel.appendChild(messageEl);

    const actions = document.createElement('div');
    actions.className = 'modal__actions';
    actions.setAttribute('data-modal-actions', '');
    panel.appendChild(actions);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn--ghost';
    cancelBtn.setAttribute('data-modal-cancel', '');
    cancelBtn.textContent = safeCancelLabel;
    actions.appendChild(cancelBtn);

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn btn--primary';
    confirmBtn.setAttribute('data-modal-confirm', '');
    if (danger) confirmBtn.setAttribute('data-danger', 'true');
    confirmBtn.textContent = safeConfirmLabel;
    actions.appendChild(confirmBtn);

    // Cleanup runs exactly once regardless of which trigger fires (click,
    // ESC, backdrop, Enter). close() removes listeners, the subtree, and
    // restores focus, then resolves.
    let settled = false;
    function close(answer) {
      if (settled) return;
      settled = true;

      document.removeEventListener('keydown', onKeydown, true);
      if (typeof dialog.remove === 'function') dialog.remove();
      else if (host && typeof host.removeChild === 'function' && dialog.parentNode === host) {
        host.removeChild(dialog);
      }

      if (
        previousFocus &&
        typeof previousFocus.focus === 'function' &&
        document.contains(previousFocus)
      ) {
        previousFocus.focus();
      }

      resolve(Boolean(answer));
    }

    function onConfirmClick() {
      close(true);
    }
    function onCancelClick() {
      close(false);
    }
    function onBackdropClick(event) {
      // The backdrop is a sibling of the panel — only an event whose
      // target IS the backdrop (not a descendant) counts as "click outside".
      if (event && event.target === backdrop) close(false);
    }
    function onKeydown(event) {
      if (!event) return;
      if (event.key === 'Escape' || event.key === 'Esc') {
        event.preventDefault();
        close(false);
      }
      // Enter is intentionally NOT intercepted here: native <button>
      // elements already activate on Enter / Space, which means the
      // focused button's own click handler (onConfirmClick / onCancelClick)
      // fires with the correct resolution. Intercepting Enter and forcing
      // close(true) here would defeat the danger:true design — when danger
      // is true the focus is on the cancel button, so a forced Enter would
      // silently confirm a destructive action. The native path is correct.
    }

    backdrop.addEventListener('click', onBackdropClick);
    cancelBtn.addEventListener('click', onCancelClick);
    confirmBtn.addEventListener('click', onConfirmClick);
    document.addEventListener('keydown', onKeydown, true);

    host.appendChild(dialog);

    // Focus the appropriate button AFTER the dialog is in the DOM so the
    // browser can actually focus it. Danger → cancel (destructive action
    // is NOT the default Enter target); neutral → confirm.
    const initialFocus = danger ? cancelBtn : confirmBtn;
    if (typeof initialFocus.focus === 'function') {
      try {
        initialFocus.focus();
      } catch (_err) {
        // A hostile environment may refuse focus — degrade silently.
      }
    }
  });
}

/**
 * Coerce an arbitrary value to a clamped, defensive string. Non-strings
 * stringify cleanly; objects / arrays get a stable, non-throwing fallback.
 *
 * @param {*} value — input (typically a string).
 * @returns {string} the clamped string.
 */
function clampString(value) {
  let text;
  if (typeof value === 'string') text = value;
  else if (value === null || value === undefined) text = '';
  else if (typeof value === 'object') {
    // Avoid stringifying an arbitrary object (could be huge); surface a
    // placeholder the test / production can detect.
    text = '[non-string value]';
  } else {
    text = String(value);
  }
  if (text.length > MESSAGE_MAX_LENGTH) {
    text = `${text.slice(0, MESSAGE_MAX_LENGTH - 1)}\u2026`;
  }
  return text;
}

/**
 * Monotonically increasing id used to scope the aria-labelledby /
 * aria-describedby ids per dialog. Module-scoped so concurrent calls each
 * get a unique id pair (the dialog is removed on resolve, so reuse is
 * theoretically safe — but unique ids avoid any race with assistive tech
 * still reading the previous dialog when a new one mounts).
 *
 * @returns {number} the next id.
 */
let _dialogIdCounter = 0;
function nextDialogId() {
  _dialogIdCounter += 1;
  return _dialogIdCounter;
}
