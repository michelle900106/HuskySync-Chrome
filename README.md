# HuskySync for Chrome

A Chrome extension that keeps UConn HuskyCT deadlines in view and syncs them to Google
Calendar and Google Tasks. It runs inside the browser, so nobody needs
Python, Playwright, or a terminal. Students install it, stay signed in to HuskyCT as
usual, and their deadlines stay up to date in the background.

## What it does

- **Reads HuskyCT for you.** It uses Blackboard Learn's REST API with the HuskyCT
  login you already have in Chrome. It reads your courses, each gradebook item that
  has a due date, and your own grade records, which show what you have submitted.
  It never handles your NetID password or Duo.
- **Syncs automatically.** It syncs shortly after Chrome starts and then every 6 hours
  (you can change this in Settings). The toolbar badge shows how many unsubmitted
  assignments are due within 48 hours.
- **Popup:** what's due in the next 7 days. **Dashboard:** every assignment, with
  semester, course, and status filters.
- **Google Calendar:** *Add to Calendar* for a single assignment, or *Add all to Google
  Calendar* for everything due within 48 hours. Each event runs from one hour before
  the deadline until the deadline. Syncing again updates the same event.
- **Google Tasks:** tick assignments and press *Sync selected to Google Tasks*.
  Submitted work is added as completed. The exact due time goes in the task notes,
  because Google Tasks stores only a date.
- **Done** checkbox for work you finished outside HuskyCT (for example McGraw-Hill
  Connect).

Everything is stored in `chrome.storage.local` in your own browser profile. The
extension talks only to your Blackboard site, and to Google when you press a Google
button.

## Try it locally (load unpacked)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose this folder (the one containing `manifest.json`).
3. Sign in to <https://lms.uconn.edu> in the same Chrome profile.
4. Click the HuskySync paw in the toolbar and press **Sync now**. Pin the
   extension from the puzzle-piece menu so it stays visible.

After you change the code, press the reload icon on the HuskySync card in
`chrome://extensions`.

HuskyCT works without any setup. Google Calendar and Google Tasks need the one-time
setup below.

## Google setup (once, by the developer)

`chrome.identity` needs an OAuth client that is tied to the extension's ID.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (or
   reuse an existing one). Enable the **Google Calendar API** and the
   **Google Tasks API**.
2. Configure the **OAuth consent screen**: add the scopes
   `.../auth/calendar.events` and `.../auth/tasks`. While the app is in
   *Testing*, add each tester's Google account as a test user.
3. **Credentials → Create credentials → OAuth client ID → Chrome Extension**. For
   *Item ID*, enter the extension ID shown on the HuskySync card in
   `chrome://extensions`.
4. Put the client ID in [manifest.json](manifest.json) under `oauth2.client_id`, then
   reload the extension.

An unpacked extension's ID depends on its folder path, so it changes if the folder
moves. To keep the ID stable, follow step 2 of the publishing section below and put
the store's public `key` in `manifest.json`. Then the local copy and the published
copy share one ID and one OAuth client.

## Publishing it for other students

1. **Chrome Web Store developer account:** register at the
   [developer dashboard](https://chrome.google.com/webstore/devconsole) (one-time fee).
2. **Upload a draft first.** Zip the contents of this folder (leave out `tests/` and
   `package.json`) and upload it. On the item's **Package** tab, copy the public key
   into `manifest.json` as `"key"`. The store and your local copy now have the same
   extension ID. Create the Chrome Extension OAuth client for that ID.
3. **Privacy:** the store requires a privacy policy, because the extension reads
   coursework. State that data stays in the user's browser and is sent only to their
   school's Blackboard and their own Google account. Declare the `identity`,
   `storage`, and `alarms` permissions and the HuskyCT host permission.
4. **Google verification:** `calendar.events` and `tasks` are *sensitive* scopes.
   While the OAuth app is unverified, only up to 100 test users can sign in, and they
   see an "unverified app" warning. To let anyone sign in, submit the consent screen
   for verification: you need a homepage, a privacy policy link, and a short video of
   the sign-in flow. HuskyCT syncing works without any of this; only the Google
   buttons depend on it.
5. **Other schools:** Settings accepts any Blackboard Learn address. Chrome asks the
   user for access to that site (`optional_host_permissions`).

The extension uses `chrome.identity.getAuthToken`, which works in Google Chrome. Edge
and other Chromium browsers would need a `launchWebAuthFlow` sign-in instead.

## Development

```bash
cd extension
npm test          # or: node --test
```

The tests cover the pure logic in `src/core.js` and run the Blackboard client against
a fake API. Calendar and Tasks requests use the same deterministic event IDs and
event/task formats as the original Python version of HuskySync, so items synced by
either version line up.

```text
manifest.json     MV3 manifest
background.js     service worker: scheduled sync, badge, sync messages
popup.html/.js    toolbar popup
dashboard.html/.js  full dashboard
options.html/.js  settings
src/core.js       pure logic (course codes, semesters, urgency, merge, Google bodies)
src/blackboard.js Blackboard REST client using the browser session
src/google.js     chrome.identity + Calendar/Tasks
src/store.js      chrome.storage layout
src/ui.js         DOM helpers
tests/            node --test suites
```

## Known limits

- **Not yet tested against a real UConn account.** The Blackboard endpoints used here
  are documented public REST endpoints (`/learn/api/public/v1|v2/...`), called with
  the browser's own session. If UConn blocks one of them for students, the extension
  shows that course's error and still reads the other courses. If grades cannot be
  read, it keeps the last known status.
- Only gradebook items that have a due date are imported. An item without a due date
  in Blackboard has nothing to put on a calendar.
- McGraw-Hill Connect: an assignment is flagged as external only when its name says so.
  The extension cannot see whether you submitted it inside Connect; use **Done**.
- The assignment link opens the course outline, not the individual item.
- Outlook email scanning (available in the Python version) is not in this version.
