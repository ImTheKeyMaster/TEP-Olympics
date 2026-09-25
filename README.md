# 2026 Grand Chapter Scavenger Hunt

A mobile-first, installable leaderboard for the 2026 Grand Chapter Scavenger Hunt. The production GitHub Pages site is **https://imthekeymaster.github.io/TEP-Olympics/**.

## Architecture

The application remains a build-free static site hosted by GitHub Pages. `app.js` imports the modular Firebase Web SDK directly from Google's CDN and connects to the `tep-olympics` Firebase project:

- **Cloud Firestore** is the persistent source of truth and sends public leaderboard changes through real-time listeners.
- **Firebase Authentication** Email/Password protects the Admin interface. There is no public registration flow.
- **Firestore Security Rules** allow public reads only for `teams` and `settings/leaderboard`; only authenticated Firebase users can write those documents. Every other collection is denied by default.
- **Firestore's persistent browser cache** retains the last received leaderboard for offline viewing. Admin writes are blocked while the browser reports it is offline and the UI waits for Firestore to acknowledge pending writes.
- `data/teams.json` is retained only as the reviewed, one-time migration seed and as an emergency display fallback if Firestore has never been available.
- The service worker caches the application shell and local team icons. Firebase supplies network synchronization and its own Firestore cache.

Firebase's web API key and project identifiers in `app.js` identify the public Firebase project; they are not secret credentials. Access control is enforced by Firebase Authentication and `firestore.rules`.

## Firestore schema

```text
teams/{teamId}
  name: string
  icon: string             # relative local icon path or HTTPS URL
  score: number            # target score; never the transient displayed score
  color: string            # six-digit CSS hex color
  order: integer           # stable Admin/migration ordering metadata
  updatedAt: timestamp

settings/leaderboard
  maxScore: number
  schemaVersion: 1
  updatedAt: timestamp
```

Reveal state is deliberately not stored. Before Reveal, clients show zeroes, empty bars, alphabetical rows, and no medals. Reveal snapshots the current Firestore target scores for the existing horse-race animation. Reset changes only that presentation state and never writes scores.

## One-time initialization / migration

The repository seed preserves the existing names, icons, scores, colors, and maximum score. To initialize a new database safely:

1. Deploy the rules first (see below).
2. In the Firebase Console, create an Email/Password Authentication user if one does not exist.
3. Open the deployed site, choose **Admin**, and sign in with that user.
4. Under **Initial data migration**, select **Initialize from Published Data** and confirm.
5. Wait for the success message, then verify the `teams` collection and `settings/leaderboard` document in the Firebase Console.

Initialization runs as a Firestore transaction. It stops rather than overwriting the leaderboard settings or any seed team document that already exists. The button is not an ongoing import tool: after initialization, use the normal Admin fields to edit Firestore directly.

## Authentication and Admin accounts

Admin uses Firebase Authentication's Email/Password provider. Auth state is managed by Firebase, and **no password is stored in this repository**. There is intentionally no sign-up UI.

To add another administrator:

1. Open **Firebase Console → Build → Authentication → Users**.
2. Select **Add user**.
3. Enter the administrator's email and a temporary/communicated password.
4. The new user can sign in through the site's Admin page.

Under the current rules, every authenticated user in this dedicated Firebase project is an administrator. Keep account creation restricted to trusted operators. Logout immediately removes Admin access in the UI, while the rules independently reject unauthenticated writes.

## Deploy Firestore rules

Install and authenticate the Firebase CLI, then run from this repository:

```sh
npm install -g firebase-tools
firebase login
firebase use tep-olympics
firebase deploy --only firestore:rules
```

`firebase.json` deploys rules only; it does **not** configure or migrate hosting. `.firebaserc` selects the existing `tep-olympics` project.

## Run locally

The app must be served over HTTP because ES modules, JSON requests, and service workers do not work correctly from `file://`:

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000/>. Add `localhost` to Firebase Authentication's Authorized Domains if it is not already present and local Admin login is needed.

To reproduce GitHub Pages' subdirectory behavior, serve `/workspace` and open <http://localhost:8000/TEP-Olympics/>. All application, manifest, icon, migration, and service-worker paths are relative to the application directory.

## GitHub Pages deployment

GitHub Pages continues to publish this repository as a static project site at `/TEP-Olympics/`; Firebase Hosting is not used. Deploy application changes with the repository's existing Pages workflow/settings (normally by pushing the configured Pages branch). Firestore score and team edits require no Git commit or Pages redeployment.

After a release, the version in `app.js`, the query strings in `index.html`, and `DEPLOYMENT_VERSION` in `service-worker.js` should be advanced together so installed clients receive the new application shell.

## PWA and offline behavior

Visit once online and allow the service worker and Firestore cache to initialize. When offline, the UI shows Firestore's last locally cached snapshot when available. If no Firestore snapshot has ever been cached, it may show the repository seed as an emergency fallback. Offline data is informational; Admin mutations are not presented as saved.

Use browser DevTools' Application panel to inspect the service worker/cache. Test PWA installation and updates over HTTPS or localhost.

## Troubleshooting

- **Permission denied while saving:** deploy `firestore.rules`, confirm the user is still signed in, and confirm the app is pointed at `tep-olympics`.
- **Login fails:** verify Email/Password is enabled, the user exists under Authentication → Users, and the current hostname is an Authorized Domain.
- **Empty leaderboard:** on a new database, complete the one-time migration. Otherwise inspect `teams` and `settings/leaderboard` and the browser console.
- **Offline cache shown:** reconnect and leave the page open briefly. The status beside “Live standings” changes from **Offline cache** to **Live** when server-backed snapshots arrive.
- **Old installed UI:** reload once online or accept the in-app update prompt. If needed, unregister the old worker in DevTools and reload.
- **Custom icon does not display:** use an HTTPS URL that permits browser loading, or one of the repository-relative built-in icon paths.
- **Rules deploy targets the wrong project:** run `firebase use tep-olympics` and confirm `.firebaserc` before deploying.

## Repository structure

- `index.html` — accessible single-page shell and Auth/Admin forms
- `styles.css` — responsive visual design
- `app.js` — Firebase initialization, real-time data flow, Auth, Admin operations, and Reveal
- `data/teams.json` — one-time migration seed and emergency fallback
- `firestore.rules` — public-read/authenticated-write allowlist and validation
- `firebase.json`, `.firebaserc` — Firestore rules deployment configuration
- `manifest.webmanifest`, `service-worker.js` — PWA metadata and application-shell cache
- `icons/` — application and team icons
