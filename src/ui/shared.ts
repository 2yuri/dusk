export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** The filled part of a range track, which WebKit can't style on its own. */
export function paintRange(input: HTMLInputElement) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  input.style.setProperty('--p', `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

/** The keys Chrome actually bound to each command, compacted: "Alt+Shift+A" becomes "⌥⇧A" on a Mac. */
export async function commandKeys(): Promise<Record<string, string>> {
  const mac = navigator.platform.startsWith('Mac');
  const out: Record<string, string> = {};
  for (const c of await chrome.commands.getAll()) {
    if (!c.name || !c.shortcut) continue;
    out[c.name] = mac
      ? c.shortcut.replace(/Alt\+?/g, '⌥').replace(/Shift\+?/g, '⇧').replace(/Ctrl\+?|Command\+?/g, '⌘').replace(/MacCtrl\+?/g, '⌃')
      : c.shortcut;
  }
  return out;
}

/** Each key of a shortcut, for drawing them as separate caps. */
export function keyCaps(shortcut: string): string[] {
  return shortcut.includes('+') ? shortcut.split('+') : [...shortcut];
}
