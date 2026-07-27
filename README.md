# 2026 Grand Chapter Scavenger Hunt

A mobile-first, offline-capable leaderboard for the 2026 Grand Chapter Scavenger Hunt. The production site is **https://imthekeymaster.github.io/TEP_Olympics/**.

## Structure

- `index.html` — the accessible single-page shell
- `styles.css` — responsive visual design
- `app.js` — routing, leaderboard, authentication, editing, and persistence
- `data/teams.json` — published initial leaderboard data
- `manifest.webmanifest` — install metadata
- `service-worker.js` — offline application cache
- `icons/` — application and fallback team icons

## Run locally

The app must be served over HTTP (opening the file directly will not load JSON or register a service worker):

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000/>. To emulate the production subdirectory, serve the parent directory and open `/TEP-Olympics/` (or rename the checkout to `TEP_Olympics`).

## Published data and local administration

Edit `data/teams.json` directly, or use Admin → JSON Data → Export JSON and commit the downloaded file at `data/teams.json`. Keep the documented structure and unique team IDs. A deployment makes that file the default for first-time visitors.

Admin changes are stored as one validated JSON document in the browser's `localStorage`; the login lasts only in `sessionStorage`. **Edits do not synchronize between browsers or devices.** GitHub Pages has no writable backend. “Reset to Published Data” removes the local override and reloads the repository copy.

The password check is in `app.js` (`passwordMatches`). Change its character sequence there. This client-side gate only prevents casual access; anyone able to inspect the source can discover or bypass it.

## PWA and offline testing

On a supported browser, use the menu's **Install App** item when it appears. Visit once online and wait for the service worker to finish installing, then enable the browser's Offline mode and reload. The interface, published data, and local icons should remain available.

The cache identifier is `CACHE_NAME` near the top of `service-worker.js`. Change its version (for example, `tep-hunt-v2`) whenever cached assets must be forcibly refreshed. Old versions are removed during activation. Test installation, updates, and offline behavior from HTTPS or localhost; service workers are unavailable on ordinary insecure origins.
