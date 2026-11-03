/**
 * Dialogs of the world menu: making a world, taking one online, renaming.
 * Built on the hub's modal look (.modal-backdrop / .modal), with forms inside.
 */
import { WORLD_NAME_MAX } from '@hub/shared';
import { h, removeWithTransition } from '../../../core/ui/dom';
import type { NewWorldOptions, WorldEntry } from '../library/WorldLibrary';

interface FormButton {
  label: string;
  value: 'ok' | '';
  primary?: boolean;
  testId?: string;
}

/** A modal with a form body; resolves true on the primary button (or Enter), false on cancel / outside tap / Esc. */
function formModal(title: string, body: Node, buttons: FormButton[], opts: { testId?: string; wide?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const close = (ok: boolean) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      removeWithTransition(backdrop);
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      } else if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName === 'INPUT') {
        e.preventDefault();
        close(true);
      }
    };
    const backdrop = h('div', { class: 'modal-backdrop entering', onclick: (e: Event) => e.target === backdrop && close(false) },
      h('form', { class: `modal vw-modal ${opts.wide ? 'vw-modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'data-testid': opts.testId, onsubmit: (e: Event) => {
        e.preventDefault();
        close(true);
      } },
        h('h3', null, title),
        h('div', { class: 'vw-modal-body scrollable' }, body),
        h('div', { class: 'modal-actions' },
          buttons.map((b) => h('button', {
            type: b.value === 'ok' ? 'submit' : 'button',
            class: `btn ${b.primary ? 'btn-primary' : ''}`,
            'data-testid': b.testId,
            onclick: b.value === 'ok' ? undefined : () => close(false),
          }, b.label)),
        ),
      ),
    );
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.remove('entering'));
  });
}

function choice<T extends string>(name: string, options: { value: T; title: string; text: string; testId?: string }[], initial: T, onChange?: (v: T) => void) {
  let value = initial;
  const el = h('div', { class: 'vw-choices', role: 'radiogroup' },
    options.map((o) => {
      const btn = h('button', {
        type: 'button',
        class: `vw-choice ${o.value === initial ? 'active' : ''}`,
        role: 'radio',
        'aria-checked': String(o.value === initial),
        'data-value': o.value,
        'data-testid': o.testId,
        name,
        onclick: () => {
          value = o.value;
          el.querySelectorAll<HTMLElement>('.vw-choice').forEach((b) => {
            b.classList.toggle('active', b.dataset.value === o.value);
            b.setAttribute('aria-checked', String(b.dataset.value === o.value));
          });
          onChange?.(o.value);
        },
      }, h('strong', null, o.title), h('span', null, o.text));
      return btn;
    }),
  );
  return { el, get: () => value };
}

const toggle = (label: string, hint: string, testId: string, checked = false) => {
  const input = h('input', { type: 'checkbox', checked, 'data-testid': testId });
  return { el: h('label', { class: 'vw-toggle' }, input, h('span', null, h('strong', null, label), h('small', null, hint))), input };
};

export async function askNewWorld(defaultName: string): Promise<NewWorldOptions | null> {
  const name = h('input', { type: 'text', class: 'vw-input', value: defaultName, maxlength: String(WORLD_NAME_MAX), 'aria-label': 'World name', 'data-testid': 'new-world-name', enterkeyhint: 'go' });
  const seed = h('input', { type: 'text', class: 'vw-input', placeholder: 'Leave empty for a surprise', maxlength: '40', 'aria-label': 'World seed', 'data-testid': 'new-world-seed', enterkeyhint: 'go' });
  const keep = toggle('Keep items when you fall', 'Your bag stays with you after a defeat.', 'new-world-keep');
  const pvp = toggle('Players can hurt each other', 'Only matters when you take the world online.', 'new-world-pvp');
  const rules = h('div', { class: 'vw-rules hidden' }, keep.el, pvp.el);
  const mode = choice('mode', [
    { value: 'sandbox', title: 'Sandbox', text: 'Every block, no danger. Build anything.', testId: 'new-world-sandbox' },
    { value: 'survival', title: 'Survival', text: 'Gather, craft and stay alive. Creatures come out at night.', testId: 'new-world-survival' },
  ], 'sandbox', (v) => rules.classList.toggle('hidden', v !== 'survival'));
  const body = h('div', { class: 'vw-form vw-form-split' },
    h('div', { class: 'vw-col' },
      h('label', { class: 'field-label' }, 'Name'), name,
      h('label', { class: 'field-label' }, 'Seed (optional)'), seed,
      h('p', { class: 'vw-hint' }, 'The same seed always grows the same land, so you can share a favourite.'),
    ),
    h('div', { class: 'vw-col' },
      h('label', { class: 'field-label' }, 'Kind of world'), mode.el,
      rules,
    ),
  );
  requestAnimationFrame(() => {
    name.focus();
    name.select();
  });
  const ok = await formModal('New world', body, [
    { label: 'Cancel', value: '' },
    { label: 'Create and play', value: 'ok', primary: true, testId: 'create-world' },
  ], { testId: 'new-world-dialog', wide: true });
  if (!ok) return null;
  return { name: name.value.trim() || defaultName, mode: mode.get(), seedText: seed.value, keepInventory: keep.input.checked, pvp: pvp.input.checked };
}

/** Public (true) / Private (false), or null when cancelled. */
export async function askHostOnline(w: WorldEntry): Promise<boolean | null> {
  const who = choice('who', [
    { value: 'private', title: 'Private', text: 'Only people you give the code to can join.', testId: 'host-private' },
    { value: 'public', title: 'Public', text: 'Listed under Open worlds: anyone can join.', testId: 'host-public' },
  ], w.hostPublic ? 'public' : 'private');
  const body = h('div', { class: 'vw-form' },
    who.el,
    h('p', { class: 'vw-hint' },
      'Your device hosts the world: keep the game open while others play. Everything they do is saved back here.',
      w.hostCode ? ` Friends can rejoin with code ${w.hostCode} if it is free.` : '',
    ),
  );
  const ok = await formModal(`Play "${w.name}" online`, body, [
    { label: 'Cancel', value: '' },
    { label: 'Go online', value: 'ok', primary: true, testId: 'host-go' },
  ], { testId: 'host-dialog' });
  return ok ? who.get() === 'public' : null;
}

export async function askRename(current: string): Promise<string | null> {
  const name = h('input', { type: 'text', class: 'vw-input', value: current, maxlength: String(WORLD_NAME_MAX), 'aria-label': 'World name', 'data-testid': 'rename-input', enterkeyhint: 'done' });
  requestAnimationFrame(() => {
    name.focus();
    name.select();
  });
  const ok = await formModal('Rename world', h('div', { class: 'vw-form' }, name), [
    { label: 'Cancel', value: '' },
    { label: 'Rename', value: 'ok', primary: true, testId: 'rename-ok' },
  ], { testId: 'rename-dialog' });
  const v = name.value.trim();
  return ok && v ? v : null;
}
