// Lucide icons, inlined at build time (esbuild text loader), same set as the design.
import arrowRight from 'lucide-static/icons/arrow-right.svg';
import arrowUpRight from 'lucide-static/icons/arrow-up-right.svg';
import chevronsUpDown from 'lucide-static/icons/chevrons-up-down.svg';
import clock from 'lucide-static/icons/clock.svg';
import contrast from 'lucide-static/icons/contrast.svg';
import crosshair from 'lucide-static/icons/crosshair.svg';
import fileCode from 'lucide-static/icons/file-code.svg';
import minus from 'lucide-static/icons/minus.svg';
import download from 'lucide-static/icons/download.svg';
import gauge from 'lucide-static/icons/gauge.svg';
import globe from 'lucide-static/icons/globe.svg';
import keyboard from 'lucide-static/icons/keyboard.svg';
import lock from 'lucide-static/icons/lock.svg';
import moon from 'lucide-static/icons/moon.svg';
import palette from 'lucide-static/icons/palette.svg';
import plus from 'lucide-static/icons/plus.svg';
import search from 'lucide-static/icons/search.svg';
import shieldCheck from 'lucide-static/icons/shield-check.svg';
import slidersHorizontal from 'lucide-static/icons/sliders-horizontal.svg';
import sun from 'lucide-static/icons/sun.svg';
import upload from 'lucide-static/icons/upload.svg';
import x from 'lucide-static/icons/x.svg';

const SVGS = {
  'arrow-right': arrowRight,
  'arrow-up-right': arrowUpRight,
  'chevrons-up-down': chevronsUpDown,
  clock,
  contrast,
  crosshair,
  'file-code': fileCode,
  minus,
  download,
  gauge,
  globe,
  keyboard,
  lock,
  moon,
  palette,
  plus,
  search,
  'shield-check': shieldCheck,
  'sliders-horizontal': slidersHorizontal,
  sun,
  upload,
  x,
};

export type IconName = keyof typeof SVGS;

/** Fills every `<span class="icon" data-icon="name">` under `root`. */
export function renderIcons(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('.icon[data-icon]')) setIcon(el, el.dataset.icon as IconName);
}

export function setIcon(el: HTMLElement, name: IconName) {
  el.dataset.icon = name;
  el.innerHTML = SVGS[name].replace(/<!--.*?-->/s, '');
  el.setAttribute('aria-hidden', 'true');
}
