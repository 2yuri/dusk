# Privacy

Dusk collects nothing. It has no analytics, no telemetry, no crash reporting, no accounts and no servers. It never sends anything about you or your browsing to anyone.

## Network requests

Dusk makes two kinds of request, and both go to URLs the page you are viewing already uses:

| What | Why | Details |
|---|---|---|
| The page's own cross-origin stylesheets | Browsers don't let extensions read CSS from another origin, so Dusk re-reads the same file the page loaded in order to recolor it | `background.ts`, `fetchCSS`. Cookies are never sent (`credentials: 'omit'`) |
| The page's own CSS background images | To find dark icons that would vanish on a dark page and recolor them | `images.ts`. Cookies are never sent. Decoding happens locally in the extension |

Everything else (fonts, icons, Dark Reader's site fixes) ships inside the extension. Dusk never contacts a server of its own; it doesn't have one.

## What is stored, and where

| Data | Where | Leaves your machine? |
|---|---|---|
| Settings, and the sites you gave a mode | `chrome.storage.sync` | Only if Chrome Sync is on: then it syncs through your Google account like any extension's settings |
| Per-site cache: CSS generated for up to 300 sites, so repeat visits go dark instantly | `chrome.storage.local` | Never. It is effectively a list of sites you visited, so Settings → About → **Clear cache** deletes it. **Nothing is cached in Incognito.** |

## Permissions

| Permission | Why |
|---|---|
| Access to all sites | To restyle the pages you visit. Dusk only reads styles and colors; it never reads form fields, passwords or page text |
| `scripting` | To register the page scripts that apply dark mode |
| `storage`, `unlimitedStorage` | Settings, and the local cache described above |
| `alarms` | To switch on and off at the times you schedule |
| `favicon` | To show the site's icon in the popup, from Chrome's local favicon cache |

You can check all of this: the code is small, and every network call is in `src/background.ts` and `src/images.ts`.
