/**
 * Minimal DOM builder used by all UI code (no framework: keeps the hub tiny).
 *
 *   h('button', { class: 'btn', onclick: go }, 'Play')
 */

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'style') {
        if (typeof value === 'string') el.style.cssText = value;
        else Object.assign(el.style, value);
      } else if (key === 'dataset') Object.assign(el.dataset, value as Record<string, string>);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key in el && typeof value !== 'string') {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(parent: Node, children: (Child | Child[])[]): void {
  for (const child of children) {
    if (Array.isArray(child)) append(parent, child);
    else if (child === null || child === undefined || child === false) continue;
    else parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

/** Inline SVG from a trusted, hard-coded markup string. */
export function svg(markup: string, className = ''): HTMLElement {
  const span = document.createElement('span');
  span.className = `svg ${className}`.trim();
  span.innerHTML = markup;
  return span;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Removes an element after its CSS exit transition (class "leaving"). */
export function removeWithTransition(el: HTMLElement, ms = 220): void {
  el.classList.add('leaving');
  window.setTimeout(() => el.remove(), ms);
}

export function hexColor(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}
