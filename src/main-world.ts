/**
 * Runs in the page's own JS world. CSS-in-JS libraries add rules through the
 * CSSOM, and shadow roots are created by page code; neither is visible to a
 * MutationObserver, so this reports them to the content script as DOM events.
 * Only strings cross the boundary.
 */
(() => {
  const w = window as Window & { __duskPage?: true };
  if (w.__duskPage) return;
  w.__duskPage = true;

  let kinds = '';
  const notify = (kind: string) => {
    if (!kinds) {
      queueMicrotask(() => {
        const detail = kinds;
        kinds = '';
        document.dispatchEvent(new CustomEvent('__dusk_cssom', { detail }));
      });
    }
    if (!kinds.includes(kind)) kinds += kind;
  };

  // i: rules added, d: removed, r: anything else (reset memos), a: adoptedStyleSheets reassigned.
  const wrap = (proto: object, name: string, kind: string) => {
    const p = proto as Record<string, unknown>;
    const orig = p[name];
    if (typeof orig !== 'function') return;
    p[name] = function (this: unknown, ...args: unknown[]) {
      const result = orig.apply(this, args);
      notify(kind);
      if (result instanceof Promise) result.then(() => notify(kind), () => {});
      return result;
    };
  };
  const sheet = CSSStyleSheet.prototype;
  wrap(sheet, 'insertRule', 'i');
  wrap(sheet, 'addRule', 'i');
  wrap(sheet, 'deleteRule', 'd');
  wrap(sheet, 'removeRule', 'd');
  wrap(sheet, 'replace', 'r');
  wrap(sheet, 'replaceSync', 'r');
  wrap(CSSGroupingRule.prototype, 'insertRule', 'r');
  wrap(CSSGroupingRule.prototype, 'deleteRule', 'r');

  for (const proto of [Document.prototype, ShadowRoot.prototype]) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets');
    if (!desc?.set) continue;
    const set = desc.set;
    Object.defineProperty(proto, 'adoptedStyleSheets', {
      ...desc,
      set(this: Document | ShadowRoot, v: CSSStyleSheet[]) {
        set.call(this, v);
        // Name the shadow root through its host, so only that root is re-read.
        if (this instanceof ShadowRoot) this.host.dispatchEvent(new CustomEvent('__dusk_adopt', { bubbles: true, composed: true }));
        else notify('a');
      },
    });
  }

  let tags = '';
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = attachShadow.call(this, init);
    if (init.mode === 'open') {
      if (!tags) {
        queueMicrotask(() => {
          const detail = tags;
          tags = '';
          document.dispatchEvent(new CustomEvent('__dusk_shadow', { detail }));
        });
      }
      if (!tags.includes(this.localName + ',')) tags += this.localName + ',';
    }
    return root;
  };
})();
