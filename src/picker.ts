import type { FixAction } from './settings.ts';
import contrastIcon from 'lucide-static/icons/contrast.svg';
import sunDim from 'lucide-static/icons/sun-dim.svg';
import circleCheck from 'lucide-static/icons/circle-check.svg';

/**
 * "Fix a spot": an on-page picker, built to design/dusk.mat ("Picker — …").
 * It lives in a closed shadow root, so the site's CSS can't reach it and the
 * site's scripts can't read it.
 */

const svg = (markup: string) => markup.replace(/<!--.*?-->/s, '');

/** Hashed class names from CSS-in-JS and CSS modules change every deploy; a fix keyed on them would break. */
function stableClass(c: string): boolean {
  return (
    c.length < 40 &&
    /^[a-zA-Z][\w-]*$/.test(c) &&
    !/\d{3,}/.test(c) &&
    !/^(css|sc|jsx|svelte|astro|emotion|chakra|mui|tw|styles?)-/i.test(c) &&
    !/__[\w-]{4,}$/.test(c) &&
    !/[a-z][A-Z].*\d|\d.*[A-Z]/.test(c)
  );
}

function part(el: Element): string {
  const tag = el.localName;
  if (el.id && /^[a-zA-Z][\w-]{0,39}$/.test(el.id) && !/\d{3,}/.test(el.id)) return `${tag}#${CSS.escape(el.id)}`;
  const classes = [...el.classList].filter(stableClass).slice(0, 2);
  return tag + classes.map((c) => `.${CSS.escape(c)}`).join('');
}

/** A selector for `el` that matches it and at most a couple of look-alikes (every copy of a logo, say). */
export function selectorFor(el: Element): string {
  let sel = part(el);
  let cur: Element | null = el;
  for (let depth = 0; depth < 4; depth++) {
    const count = document.querySelectorAll(sel).length;
    if (count >= 1 && count <= 3 && /[.#]/.test(sel)) return sel;
    cur = cur.parentElement;
    if (!cur || cur === document.body || cur === document.documentElement) break;
    sel = `${part(cur)} > ${sel}`;
  }
  if (document.querySelectorAll(sel).length > 3 && el.parentElement) {
    const same = [...el.parentElement.children].filter((c) => c.localName === el.localName);
    if (same.length > 1) sel += `:nth-of-type(${same.indexOf(el) + 1})`;
  }
  return sel;
}

const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer { position: fixed; inset: 0; pointer-events: none; font: 400 13px/1.4 'Dusk Inter', system-ui, sans-serif; color: #edeaf5; -webkit-font-smoothing: antialiased; }
.bar, .menu, .toast { pointer-events: auto; position: fixed; background: #0f0e17; border: 1px solid #2f2b3d; box-shadow: 0 8px 24px rgba(0,0,0,.55); }
.bar { top: 12px; left: 50%; transform: translateX(-50%); width: 380px; height: 40px; padding: 0 8px 0 14px; gap: 12px; display: flex; align-items: center; border-radius: 999px; }
.mark { font: 800 16px/1 'Dusk Inter Tight', 'Dusk Inter', system-ui, sans-serif; }
.mark b { color: #ff9466; font-weight: inherit; }
.bar .text { flex: 1; }
.cancel { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border: 0; border-radius: 999px; background: #191722; color: #9893ab; font: 400 12px/1.4 'Dusk Inter', system-ui, sans-serif; cursor: pointer; }
.cancel kbd { padding: 1px 5px; border: 1px solid #2f2b3d; border-radius: 4px; font: 400 10.5px/1.3 'Dusk Mono', ui-monospace, monospace; color: #9893ab; }
.highlight { position: fixed; border: 2px solid #a896ff; border-radius: 6px; background: rgba(168,150,255,.12); transition: all 60ms linear; }
.tag { position: fixed; padding: 3px 7px; border-radius: 4px; background: #a896ff; color: #15121f; font: 500 11px/1.3 'Dusk Mono', ui-monospace, monospace; white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
.menu { width: 300px; padding: 6px; border-radius: 12px; background: #191722; box-shadow: 0 12px 32px rgba(0,0,0,.55); }
.head { padding: 8px 10px 6px; display: flex; flex-direction: column; gap: 2px; }
.head strong { font-weight: 600; }
.where { font: 400 11px/1.4 'Dusk Mono', ui-monospace, monospace; color: #9893ab; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.option { width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px; border: 0; border-radius: 8px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.option:hover, .option:focus-visible { background: #23202e; outline: none; }
.option .box { flex: none; display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; background: #23202e; }
.option:hover .box, .option:focus-visible .box { background: #2f2b3d; }
.option svg { width: 16px; height: 16px; color: #edeaf5; }
.option span { display: flex; flex-direction: column; gap: 1px; }
.option strong { font-weight: 600; }
.option small { font-size: 12px; color: #9893ab; }
.foot { margin-top: 0; padding: 8px 10px 6px; border-top: 1px solid #2f2b3d; font-size: 12px; color: #9893ab; }
.toast { bottom: 28px; left: 50%; transform: translateX(-50%); width: 360px; height: 44px; padding: 0 6px 0 14px; gap: 10px; display: flex; align-items: center; border-radius: 999px; background: #191722; }
.toast svg { flex: none; width: 16px; height: 16px; color: #a896ff; }
.toast .text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.undo { padding: 6px 12px; border: 0; border-radius: 999px; background: #23202e; color: #edeaf5; font: 600 13px/1.4 'Dusk Inter', system-ui, sans-serif; cursor: pointer; }
`;

let fontsLoaded: Promise<unknown> | null = null;
/** Brand fonts for the overlay, through Chrome's per-session random resource URLs so pages can't probe for them. */
function loadFonts() {
  fontsLoaded ??= Promise.all(
    [
      ['Dusk Inter', 'fonts/inter.woff2'],
      ['Dusk Inter Tight', 'fonts/inter-tight.woff2'],
      ['Dusk Mono', 'fonts/jetbrains-mono.woff2'],
    ].map(([family, path]) => {
      const face = new FontFace(family, `url(${chrome.runtime.getURL(path)})`, { weight: '100 900' });
      document.fonts.add(face);
      return face.load().catch(() => {});
    }),
  );
  return fontsLoaded;
}

export interface PickerOptions {
  host: string;
  /** Under a filter-mode page the overlay would be inverted along with it; invert it back. */
  inverted: boolean;
  onFix(selector: string, action: FixAction): Promise<void>;
  onUndo(selector: string): Promise<void>;
}

let active: (() => void) | null = null;

declare global {
  /** Set when the popup injects this file into a tab; the content script calls it. */
  var __duskStartPicker: typeof startPicker | undefined;
}

export function startPicker(opts: PickerOptions) {
  active?.();
  loadFonts();
  const hostEl = document.createElement('dusk-picker');
  hostEl.style.cssText = `all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;${opts.inverted ? 'filter:invert(1) hue-rotate(180deg);' : ''}`;
  const root = hostEl.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS_TEXT;
  const layer = document.createElement('div');
  layer.className = 'layer';
  root.append(style, layer);
  document.documentElement.append(hostEl);

  const el = (tag: string, cls: string, html = '') => Object.assign(document.createElement(tag), { className: cls, innerHTML: html });
  const bar = el('div', 'bar', '<span class="mark">d<b>.</b></span><span class="text">Click the part that looks wrong</span>');
  const cancel = el('button', 'cancel', '<kbd>Esc</kbd>Cancel');
  bar.append(cancel);
  const highlight = el('div', 'highlight');
  const tag = el('div', 'tag');
  highlight.hidden = tag.hidden = true;
  layer.append(highlight, tag, bar);

  let target: Element | null = null;
  let locked = false;
  let menu: HTMLElement | null = null;
  let frame = 0;

  const ours = (e: Event) => e.composedPath().includes(hostEl);

  const place = () => {
    frame = 0;
    if (!target?.isConnected) {
      highlight.hidden = tag.hidden = true;
      return;
    }
    const r = target.getBoundingClientRect();
    const pad = 5;
    Object.assign(highlight.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    highlight.hidden = false;
    const below = r.bottom + pad + 4;
    tag.style.left = `${Math.max(4, r.left - pad)}px`;
    tag.style.top = `${below + 22 > innerHeight ? r.top - pad - 26 : below}px`;
    tag.hidden = locked;
    if (menu) {
      const top = r.bottom + pad + 8;
      const h = menu.offsetHeight;
      menu.style.left = `${Math.min(Math.max(8, r.left - pad), innerWidth - 308)}px`;
      menu.style.top = `${top + h > innerHeight - 8 ? Math.max(8, r.top - pad - 8 - h) : top}px`;
    }
  };
  const replace = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };

  const hover = (e: PointerEvent) => {
    if (locked || ours(e)) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (!hit || hit === hostEl || hit === document.documentElement || hit === document.body) return;
    if (hit !== target) {
      target = hit;
      tag.textContent = selectorFor(hit);
      replace();
    }
  };

  const block = (e: Event) => {
    if (ours(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  const choose = (e: MouseEvent) => {
    if (ours(e)) return;
    block(e);
    if (!target) return;
    locked = true;
    bar.querySelector('.text')!.textContent = 'Choose a fix for this element';
    const sel = selectorFor(target);
    menu?.remove();
    menu = el('div', 'menu');
    const head = el('div', 'head', '<strong>Fix this element</strong>');
    head.append(Object.assign(document.createElement('span'), { className: 'where', textContent: `${sel} · ${opts.host}` }));
    const option = (icon: string, title: string, desc: string, action: FixAction) => {
      const b = el('button', 'option', `<span class="box">${svg(icon)}</span><span><strong>${title}</strong><small>${desc}</small></span>`);
      b.onclick = async () => {
        finish();
        await opts.onFix(sel, action);
        toast(`${action === 'invert' ? 'Inverted' : 'Dimmed'} ${sel} on ${opts.host}`, sel);
      };
      return b;
    };
    const foot = el('div', 'foot');
    foot.textContent = `Saved for ${opts.host}. Undo it any time in settings.`;
    menu.append(
      head,
      option(contrastIcon, 'Invert colors', 'For logos and diagrams that disappear in the dark.', 'invert'),
      option(sunDim, 'Dim', 'For images and banners that glare.', 'dim'),
      foot,
    );
    layer.append(menu);
    place();
    (menu.querySelector('.option') as HTMLElement).focus();
  };

  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (menu) {
      // Back to choosing.
      menu.remove();
      menu = null;
      locked = false;
      bar.querySelector('.text')!.textContent = 'Click the part that looks wrong';
      replace();
    } else {
      finish();
      hostEl.remove();
    }
  };

  const toast = (text: string, sel: string) => {
    layer.replaceChildren();
    const t = el('div', 'toast', svg(circleCheck));
    t.append(Object.assign(document.createElement('span'), { className: 'text', textContent: text }));
    const undo = el('button', 'undo', 'Undo');
    undo.onclick = async () => {
      hostEl.remove();
      await opts.onUndo(sel);
    };
    t.append(undo);
    layer.append(t);
    setTimeout(() => hostEl.remove(), 6000);
  };

  const events: [string, EventListener][] = [
    ['pointermove', hover as EventListener],
    ['click', choose as EventListener],
    ['pointerdown', block],
    ['mousedown', block],
    ['mouseup', block],
    ['pointerup', block],
    ['keydown', key as EventListener],
    ['scroll', replace],
    ['resize', replace],
  ];
  for (const [type, fn] of events) window.addEventListener(type, fn, true);
  cancel.onclick = () => {
    finish();
    hostEl.remove();
  };

  /** Stop picking; the overlay may stay for the toast. */
  function finish() {
    for (const [type, fn] of events) window.removeEventListener(type, fn, true);
    cancelAnimationFrame(frame);
    highlight.remove();
    tag.remove();
    menu?.remove();
    bar.remove();
    active = null;
  }
  active = () => {
    finish();
    hostEl.remove();
  };
}

// Loaded on demand (popup → "Fix a spot"), never with every page.
globalThis.__duskStartPicker = startPicker;
