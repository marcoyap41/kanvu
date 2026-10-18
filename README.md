# Kanvu

A simple, customizable, and free Kanban task management web app. Sign in to keep your boards, appearance settings and wallpaper on any device.

Open one page and start organizing. Kanvu gives you a fast, good-looking board that you can make entirely your own, with no subscription and no paid tiers.

**Live demo: [kanvu.vercel.app](https://kanvu.vercel.app)**

## Why Kanvu

There is no shortage of Kanban tools. Most of them are built for teams, and they come with workspaces, onboarding, and a pricing page. If all you want is a quick place to keep track of your own tasks, that is a lot of overhead. Kanvu was built for that gap.

**Simple by design**
Kanvu is a single web page. Open it and start building a board right away, with no sign-up needed to try it. A free account is only needed when you want to save, and signing in takes an email and a password.

**Yours to customize**
The main focus of Kanvu is letting you shape the board to fit how you like to work and how you like it to look:
- Set your own wallpaper, cropped to the exact ratio of the board so it always fits.
- Choose a theme, and color-code stages and individual tasks.
- Switch between a column layout and horizontal lanes, and pick how many columns to show and how detailed the cards are.
- Turn on a frosted-glass header bar, and make stages and cards translucent so your wallpaper shows through, with sliders for both opacity and blur.

Your appearance settings and wallpaper are saved to your account, so the board looks the same on every device.

**Free, with nothing locked away**
Every customization option is available to everyone. There are no paid tiers, no premium backgrounds, and no features held back behind a subscription, which is a common pattern in other task management apps. What you see here is the full app.

**Your boards, on any device**
Boards are saved to your account on the server, so you can pick up where you left off on any device. You can export any board to JSON for backup or to move it elsewhere. Kanvu is also open: you can run your own server and database (see below) and keep everything under your control.

## Getting started

**Use it online:** open [kanvu.vercel.app](https://kanvu.vercel.app) and start building a board right away. Sign in or create an account to save it. Until you do, your boards are only a temporary draft in that tab.

**Run it locally:** Kanvu has two parts: this frontend, and the `kanvu-api` server, which lives in a separate repository and stores everything in PostgreSQL. Saving needs both, so you run your own server and your own database.

You need:
- Node.js (current LTS)
- PostgreSQL
- Git

1. **Create a PostgreSQL database** for Kanvu.
2. **Run `kanvu-api`** (separate repository):
   - Clone it and install its dependencies with `npm install`.
   - Create its `.env` file with your database connection settings, a `JWT_SECRET` (any long random string), and `FRONTEND_URL` set to the address you will serve this frontend from, for example `http://localhost:5173`. The API uses it for CORS and for the sign-in cookie. The `kanvu-api` README lists the exact variables.
   - Start it with `npm run start:dev`. It listens on `http://localhost:3000` by default.
3. **Point the frontend at your API.** Clone this repository and set the URL in `config.js`:
   ```js
   const KANVU_CONFIG = {
       apiUrl: 'http://localhost:3000'
   };
   ```
4. **Serve the frontend over HTTP.** Opening `index.html` directly with `file://` does not work, because sign-in relies on a cookie that needs a real web origin. From this folder run:
   ```
   npx serve -l 5173 .
   ```
5. **Open `http://localhost:5173`**, create an account, and start saving boards.

Email and password sign-in works with just the steps above. Sign-in with Google or GitHub additionally needs OAuth credentials configured in `kanvu-api`.

The interface fonts load from Google Fonts; without an internet connection the app falls back to system fonts.

**Troubleshooting**
- *Sign-in works but you look signed out after a reload:* `FRONTEND_URL` in `kanvu-api` must match the address bar exactly (same scheme, host and port, no trailing slash), and both the frontend and the API should use `localhost`, not one of them `127.0.0.1`.
- *The page shows "Cannot reach the server":* the API is not running, or `apiUrl` in `config.js` points to the wrong address.
- *`npx serve` fails because port 3000 is taken:* use `-l 5173` as above, since the API uses 3000.

**Deploying your own instance:** host the frontend and the API so they share one registrable domain, for example `app.example.com` and `api.example.com`. Sign-in uses an httpOnly cookie, and browsers increasingly block cookies between unrelated domains. Set `apiUrl` to the API's public URL and `FRONTEND_URL` to the frontend's public URL.

## Features

**Accounts**
- Sign in with email and password, or with Google or GitHub when configured on the server.
- Try the app signed out: you can create boards and cards in a draft that is not saved. Save asks you to sign in, and autosave is off until you do.
- After signing in you can add the draft to your account or discard it.

**Boards and stages**
- Multiple boards, with create, duplicate, reorder, and a trash to restore deleted boards.
- Customizable stages (add, rename, recolor, reorder, delete).
- Column layout or horizontal lane layout.

**Tasks**
- Title, notes, priority, difficulty (1 to 5), progress, and a color tag.
- Drag and drop between stages, with a live preview of where the card will land. Works with mouse, pen and touch.
- Search to find tasks quickly.

**Appearance**
- Light, Dusk and Dark themes.
- Three detail levels (Comfortable, Compact, Dense) and adjustable card size or columns shown.
- Custom wallpaper with a fixed-ratio crop (drag to position, scroll or slider to zoom).
- Blurry, semi-transparent header bar, plus translucent stages and cards, with adjustable opacity and separate blur for the header and stages. These options are in the Wallpaper dialog in the sidebar.
- Appearance settings and the wallpaper are saved to your account.

**Data**
- Manual save or optional autosave when signed in.
- Export a board to JSON and import it back, either replacing the current board or as a new one.

## Data storage

- **Account mode (Signed In):** Boards, stages, tasks, user appearance settings, and wallpapers are stored on the server via `kanvu-api` (PostgreSQL).
- **Draft mode (Signed Out):** Boards and settings live temporarily in `sessionStorage` for the current tab only. The draft survives a reload and the Google or GitHub sign-in redirect in the same tab, and disappears when the tab closes.
- Comprehensive documentation: [`docs/SYSTEM_DOCUMENTATION.md`](docs/SYSTEM_DOCUMENTATION.md).

## Project structure

```
index.html                  Page structure and dialogs
style.css                   Styles, layouts and themes
kanban.js                   Application logic (boards, tasks, drag and drop, appearance)
account.js                  Account button, modals, draft-to-account import, session management
app.js                      Application bootstrap, session restoration, and storage selection
storage/api-adapter.js      Server-backed storage adapter (boards, settings, wallpaper)
storage/local-storage.js    In-browser session draft storage adapter
storage/prefs.js            SettingsManager (server-synced in account mode, sessionStorage draft)
storage/auth.js             JWT auth client, token refresh, and OAuth integration
config.js                   Backend API URL configuration
docs/                       Architecture & contract specifications
```

## Browser support

Any recent version of Chrome, Edge, Firefox or Safari. The blur effects rely on `backdrop-filter`.

## Architecture: Draft Mode & Account Mode

Kanvu operates behind a unified storage adapter interface:

- **Account mode** (signed in): boards, settings, and wallpaper live on the server through the API (`storage/api-adapter.js`, `storage/auth.js`, `storage/prefs.js`).
- **Draft mode** (signed out): you can create boards and cards, but nothing is saved permanently. The draft lives in this tab's `sessionStorage` and vanishes when the tab closes. Upon sign in, you can import your draft boards to your account or discard them.
- **Unified Sign-In CTA:** The top-right button adapts seamlessly between "Sign in to save" (draft mode) and user avatar (account mode).

For complete technical specifications, see:
- System Architecture & API Guide: [`docs/SYSTEM_DOCUMENTATION.md`](docs/SYSTEM_DOCUMENTATION.md)
- REST API Contract: [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md)
- Storage Adapter Specification: [`docs/STORAGE_ADAPTER.md`](docs/STORAGE_ADAPTER.md)
