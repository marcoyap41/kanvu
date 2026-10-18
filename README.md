# Kanvu

A simple, customizable, and free Kanban task management web app with local data storage.

Open one page, start organizing. No account, no setup, no subscription. Kanvu gives you a fast, good-looking board that you can make entirely your own.

**Live demo: [kanvu.vercel.app](https://kanvu.vercel.app)**

## Why Kanvu

There is no shortage of Kanban tools. Most of them are built for teams, and they come with sign-ups, workspaces, onboarding, and a pricing page. If all you want is a quick place to keep track of your own tasks, that is a lot of overhead. Kanvu was built for that gap.

**Simple by design**
Kanvu is a single web page. There is no login to create, no email to confirm, and nothing to install. Open it and your board is ready. It is made for people who want quick, efficient access to a personal task board and nothing standing in the way.

**Yours to customize**
The main focus of Kanvu is letting you shape the board to fit how you like to work and how you like it to look:
- Set your own wallpaper, cropped to the exact ratio of the board so it always fits.
- Choose a theme, and color-code stages and individual tasks.
- Switch between a column layout and horizontal lanes, and pick how many columns to show and how detailed the cards are.
- Turn on a frosted-glass header bar, and make stages and cards translucent so your wallpaper shows through, with sliders for both opacity and blur.

**Free, with nothing locked away**
Every customization option is available to everyone. There are no paid tiers, no premium backgrounds, and no features held back behind a subscription, which is a common pattern in other task management apps. What you see here is the full app.

**Your data stays with you**
Boards are stored locally in your browser, not on someone else's server. There is no account to be tied to, and you can export any board to JSON for backup or to move it elsewhere.

## Getting started

**Use it online:** open [kanvu.vercel.app](https://kanvu.vercel.app) and start right away.

**Run it locally:**
1. Download or clone this repository.
2. Open `index.html` in a modern browser.

That is all. The interface fonts load from Google Fonts; without an internet connection the app falls back to system fonts.

## Features

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

**Data**
- Manual save or optional autosave.
- Export a board to JSON and import it back, either replacing the current board or as a new one.
- Open tabs stay in sync with each other.

## Data storage

- Boards and settings are stored in the browser's `localStorage`.
- The wallpaper image is stored in `IndexedDB`, since it is too large for `localStorage`.
- Data lives in the browser on the device you use (and per site address, so the online version and a local copy do not share boards), so it does not sync between devices. Clearing site data removes your boards and wallpaper, so export important boards as JSON for backup.

## Project structure

```
index.html   Page structure and dialogs
style.css    Styles and themes
kanban.js    Application logic (boards, tasks, drag and drop, appearance)
favicon.svg  Icon
```

## Browser support

Any recent version of Chrome, Edge, Firefox or Safari. The blur effects rely on `backdrop-filter`.

## Credits

Original Kanvu by Marco Christian.

## Architecture: guest mode and account mode

Kanvu has two storage modes behind one interface:

- **Account mode** (signed in): boards live on the server through the API (`storage/api-adapter.js`, `storage/auth.js`).
- **Draft** (signed out, when `config.js` has an `apiUrl`): you can create boards and cards, but nothing is saved. Save asks you to sign in, autosave is off, and a banner says so. The draft lives only in this tab's sessionStorage, so it survives a reload and the Google/GitHub redirect and disappears when the tab closes. On sign in you can add it to your account or discard it; signing out leaves an empty draft.
- **Guest mode** (no `apiUrl`, for development): boards stay in localStorage and there is no sign-in, as before.

The board code talks only to `kanban.storage`, so it works the same in both modes. `kanban.setStorage(adapter)` switches between them (sign in, sign out). Contracts: [`docs/STORAGE_ADAPTER.md`](docs/STORAGE_ADAPTER.md) and [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md).

| File | Role |
|---|---|
| `config.js` | `apiUrl` of the backend. Set = account required (draft when signed out). Empty = guest-only app, no sign-in button |
| `storage/prefs.js` | Device-only appearance settings |
| `storage/local-storage.js` | Browser storage adapter: localStorage (guest) or sessionStorage (signed-out draft) |
| `storage/auth.js` | Sign in, register, token refresh, authenticated requests |
| `storage/api-adapter.js` | Account storage |
| `account.js` | Account button, not-saved banner, sign-in dialog, sign out, adding the draft to the account |
| `app.js` | Chooses account, draft or guest mode at startup; loading and server-error screens |
| `mock-server/server.js` | In-memory fake backend for developing the frontend |
| `tests/` | End-to-end tests (jsdom) for both modes |

Try account mode without the real backend: `node mock-server/server.js`, set `apiUrl: 'http://localhost:3000'` in `config.js`, and serve the folder (e.g. `npx serve .`).
