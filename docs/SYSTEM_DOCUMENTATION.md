# Kanvu & Kanvu API — Comprehensive System Documentation

> **Version:** 2.1 (Full Stack, Server-Synced Architecture)  
> **Date:** October 2026  
> **Frontend:** `newkanvu/` (Vanilla ES6, HTML5, CSS3)  
> **Backend:** `kanvu-api/` (NestJS 10, TypeORM, PostgreSQL)

---

## 1. Executive Summary & Architecture Overview

Kanvu is a personal Kanban task management web platform engineered around clarity, customizability, and speed.

Initially created as a client-side single-page application with browser-only storage, the latest architecture introduces a full-stack design powered by `kanvu-api`, a NestJS + PostgreSQL service.

### Key Architectural Shifts in the Latest Version:
1. **Server-Side Settings & Wallpaper Sync:** All user appearance preferences (theme, card density, columns, glassmorphism, blur amounts, autosave) and custom wallpaper images are persisted directly to PostgreSQL via `/settings` and `/settings/wallpaper`.
2. **Zero `localStorage` Data Footprint:** Deprecated client-side persistent storage. No boards, cards, settings, or wallpapers reside in browser `localStorage` or `IndexedDB`.
3. **Session-Isolated Draft Mode:** Unauthenticated users work in an isolated, temporary draft stored exclusively in `sessionStorage`. Tab closure drops the draft unless the user signs in to migrate their work to their account.
4. **Unified Header CTA:** Streamlined the unauthenticated UX by eliminating redundant "Sign in to save" and "Sign in" buttons into a single contextual primary action.
5. **Enhanced Lanes Display:** Native horizontal CSS scroll-snap with `scroll-padding-left` prevents sticky edge behavior on overflow.

```mermaid
graph TD
    subgraph Client ["Client Browser (newkanvu)"]
        UI[Kanvu UI / DOM]
        KM[Kanvu Core Application]
        SM[SettingsManager / prefs]
        AU[AccountUI & Auth Modals]
        AC[AuthClient (In-Memory JWT)]
        
        subgraph Adapters ["Storage Adapters"]
            LSA["LocalStorageAdapter (sessionStorage Draft)"]
            API["ApiAdapter (Server-Backed)"]
        end
    end

    subgraph Backend ["Backend API (kanvu-api: NestJS)"]
        AuthM["AuthModule (JWT + Refresh Cookie)"]
        BoardM["BoardsModule (CRUD, Order, Trash)"]
        SetM["SettingsModule (JSONB Settings)"]
        WallM["Wallpaper Controller (Bytea Streaming)"]
    end

    subgraph Database ["PostgreSQL Database"]
        U[(users)]
        B[(boards)]
        W[(wallpapers)]
        RT[(refresh_tokens)]
        OA[(oauth_accounts)]
    end

    UI --> KM
    KM --> SM
    KM --> AU
    AU --> AC
    KM --> Adapters

    LSA -.->|Unauthenticated Session| SessionStorage[(Browser sessionStorage)]
    API -->|Authenticated REST| Backend
    AC -->|Bearer JWT / Cookie| Backend

    AuthM --> U
    AuthM --> RT
    AuthM --> OA
    BoardM --> B
    SetM --> U
    WallM --> W
```

---

## 2. Storage Architecture: Draft vs. Account Mode

Kanvu implements an adapter pattern (`docs/STORAGE_ADAPTER.md`) decoupling board and state management from underlying persistence.

| Feature / Aspect | Draft Mode (Guest) | Account Mode (Signed In) |
|---|---|---|
| **Storage Engine** | `LocalStorageAdapter(sessionStorage, { draft: true })` | `ApiAdapter(auth)` |
| **Persistence Target** | Browser `sessionStorage` (tab-scoped) | PostgreSQL Database via REST API |
| **Board Capacity** | Full features (create, edit, reorder, lanes) | Full features + multi-device persistence |
| **Save Behavior** | Manual save disabled; CTA prompts to sign in | Manual save or optional real-time debounced autosave |
| **Appearance & Settings** | In-memory with fallback to `sessionStorage` | Server-synced via `GET /settings` and debounced `PATCH /settings` |
| **Wallpaper** | In-memory Object URL preview | Stored in PostgreSQL (`bytea`), streamed via `GET /settings/wallpaper` |
| **Data Lifecycle** | Vanishes on tab close unless imported | Retained permanently in user account |
| **Cross-Device Sync** | None | Automatic upon sign-in / reload |

### Guest-to-Account Draft Migration Flow
When an unauthenticated guest constructs boards and subsequently signs in:
1. `AuthClient` authenticates via `/auth/login` or OAuth redirect (`#auth=success`).
2. `AccountUI.afterAuth()` checks `makeDraft().loadAll()`.
3. If guest boards exist and have content, an interactive modal prompts:
   - **"Add to my account"**: Sends `POST /boards/import` with board payloads. The backend assigns persistent UUIDs, appends them to the user's board list, and `sessionStorage` is cleared.
   - **"Discard"**: Clears `sessionStorage` draft and loads existing account boards.

---

## 3. Backend Specification (`kanvu-api`)

The backend is built with **NestJS**, **TypeORM**, and **PostgreSQL**.

### 3.1 Entity Schemas

#### User (`users`)
```typescript
@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 50, nullable: true })
  name: string | null;

  @Column({ unique: true })
  email: string;

  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  password: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  settings: UserSettings;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => Board, (b) => b.user)
  boards: Board[];

  @OneToOne(() => Wallpaper, (w) => w.user)
  wallpaper: Relation<Wallpaper> | null;
}
```

#### UserSettings Type
```typescript
export type UserSettings = Partial<{
  theme: 'black' | 'grey' | 'white';
  density: 'comfortable' | 'compact' | 'dense';
  columnLayout: 3 | 4 | 5;
  layout: 'columns' | 'lanes';
  headerBlur: boolean;
  glassLanes: boolean;
  glassCards: boolean;
  glassOpacity: number;
  headerBlurAmount: number;
  stageBlurAmount: number;
  autosave: boolean;
  wallpaperVersion: string;
}>;
```

#### Board (`boards`)
```typescript
@Entity()
@Index(['userId', 'deletedAt'])
export class Board {
  @PrimaryColumn('uuid')
  id: string;

  @Column()
  userId: number;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  tasks: JsonObject[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  columns: JsonObject[];

  @Column({ type: 'int' })
  position: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  lastModified: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt: Date | null;
}
```

#### Wallpaper (`wallpapers`)
```typescript
@Entity('wallpapers')
export class Wallpaper {
  @PrimaryColumn()
  userId: number;

  @OneToOne(() => User, (u) => u.wallpaper, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  @Column({ type: 'bytea' })
  data: Buffer;

  @Column({ type: 'varchar', length: 20 })
  mimeType: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
```

---

### 3.2 REST API Reference

All protected endpoints require `Authorization: Bearer <accessToken>`.

#### Authentication (`/auth`)
| Method | Endpoint | Description | Request Body | Response |
|---|---|---|---|---|
| `POST` | `/auth/register` | Register new account | `{ email, password, name? }` | `201 { accessToken, user }` + httpOnly refresh cookie |
| `POST` | `/auth/login` | Login with credentials | `{ email, password }` | `200 { accessToken, user }` + httpOnly refresh cookie |
| `POST` | `/auth/refresh` | Rotate access token | None (reads cookie) | `200 { accessToken, user }` + new refresh cookie |
| `POST` | `/auth/logout` | Revoke session | None (reads cookie) | `204 No Content` (clears cookie) |
| `GET` | `/auth/google` | OAuth Google Redirect | None | Redirects to Google OAuth |
| `GET` | `/auth/github` | OAuth GitHub Redirect | None | Redirects to GitHub OAuth |

#### Boards (`/boards`)
| Method | Endpoint | Description | Request Body | Response |
|---|---|---|---|---|
| `GET` | `/boards` | Load all user boards | None | `200 { boards: Board[], order: string[], trash: Board[] }` |
| `PUT` | `/boards/:id` | Upsert board by UUID | Full `Board` JSON | `200 Board` |
| `PUT` | `/board-order` | Persist visual order | `{ ids: string[] }` | `204 No Content` |
| `POST` | `/boards/:id/trash` | Soft-delete board | Full `Board` JSON | `200 Board & { deletedAt }` |
| `POST` | `/boards/:id/restore` | Restore from trash | None | `200 Board` |
| `DELETE` | `/boards/:id` | Purge permanently | None | `204 No Content` (board must be in trash) |
| `DELETE` | `/trash` | Empty all trash | None | `204 No Content` |
| `POST` | `/boards/import` | Import guest boards | `{ boards: Board[] }` | `201 { idMap, boards }` |

#### Settings & Customization (`/settings`)
| Method | Endpoint | Description | Request Body | Response |
|---|---|---|---|---|
| `GET` | `/settings` | Retrieve user settings | None | `200 { settings: UserSettings }` |
| `PATCH` | `/settings` | Partial settings update | `UpdateSettingsDto` | `200 { settings: UserSettings }` |
| `GET` | `/settings/wallpaper` | Stream wallpaper image | None | Binary stream (`Content-Type: image/jpeg\|png\|webp`) |
| `PUT` | `/settings/wallpaper` | Upload image (max 4MB)| `multipart/form-data` with `file` | `200 { wallpaperVersion: string }` |
| `DELETE`| `/settings/wallpaper` | Remove custom wallpaper| None | `200` / `204` |

---

## 4. Frontend Architecture (`newkanvu`)

The frontend is implemented in vanilla modern JavaScript without external compilation or heavyweight UI frameworks.

### 4.1 Script Structure and Load Hierarchy

In [`index.html`](file:///d:/003_Coding/newkanvu/index.html):
```html
<script src="config.js"></script>
<script src="storage/prefs.js"></script>
<script src="storage/local-storage.js"></script>
<script src="storage/auth.js"></script>
<script src="storage/api-adapter.js"></script>
<script src="kanban.js"></script>
<script src="account.js"></script>
<script src="app.js"></script>
```

### 4.2 Module Breakdown

#### 1. `config.js`
Defines runtime backend endpoint:
```javascript
const KANVU_CONFIG = {
    apiUrl: 'http://localhost:3000'
};
```

#### 2. `storage/prefs.js` (`SettingsManager`)
* Instantiated globally as `const prefs = new SettingsManager()`.
* Maintains an in-memory settings cache initialized from system defaults.
* In draft mode: changes persist to `sessionStorage` for the tab session.
* In account mode: `set()` updates in-memory cache and triggers a 600ms debounced `PATCH /settings`.
* Automatically casts string/boolean/number types before transmission to ensure strict compatibility with NestJS `ValidationPipe`.
* Supports `pause()` and `resume()` to prevent feedback loops while applying server settings to the UI.

#### 3. `storage/api-adapter.js` (`ApiAdapter`)
* Implements the storage adapter interface for authenticated users.
* Communicates with `/boards`, `/board-order`, and `/trash`.
* Implements binary image streaming via `_fetchBinary()`, which automatically handles 401 token refresh retries.
* Provides `getWallpaper()`, `putWallpaper()`, and `deleteWallpaper()`.

#### 4. `storage/local-storage.js` (`LocalStorageAdapter`)
* Default store: `sessionStorage` (draft mode).
* Provides synchronous board signature computations and merge-on-write functionality.

#### 5. `storage/auth.js` (`AuthClient`)
* Manages the short-lived in-memory `accessToken` (never saved in web storage).
* Sends requests with `credentials: 'include'` for secure cookie rotation.
* Automatically refreshes expired tokens on 401 responses.

#### 6. `kanban.js` (`Kanvu`)
* Core UI controller handling DOM rendering, columns/lanes switching, card modals, task filtering, drag-and-drop mechanics, and theme styling.
* Manages wallpaper cropping via HTML5 Canvas (high-quality bilinear interpolation with max-dimension constraints).
* Provides `_applySettings(serverSettings)` and `resetToDefaultSettings()`.

#### 7. `account.js` (`AccountUI`)
* Controls the top-right header button (`#account-button`) and account menu.
* Renders auth modals (Sign in, Register, Google, GitHub OAuth).
* Orchestrates post-auth state via `afterAuth()` and clean session teardown via `signOut()`.

#### 8. `app.js`
* Bootstrap coordinator:
  1. Purges deprecated `localStorage` keys from legacy versions.
  2. Instantiates `AuthClient`, `LocalStorageAdapter`, and `Kanvu`.
  3. Evaluates `restoreSession()`. If valid, promotes storage to `ApiAdapter`.
  4. Mounts `AccountUI`.

---

## 5. UI/UX Refactor Details

### 5.1 Single Contextual Sign-In CTA
* **Previous behavior:** In guest mode, unauthenticated users saw both a `"Sign in to save"` button (replacing the Save button) and a separate `"Sign in"` account button side-by-side.
* **New behavior:** The Save button is hidden (`hidden = true`) in draft mode. The `#account-button` transforms into `"Sign in to save"`. Once signed in, the Save button appears as `Save` / `Saved ✔` and the account button displays the user avatar.

### 5.2 Horizontal Scroll-Snap Padding in Lanes Mode
* **Issue:** In lanes mode, horizontal task lists with `scroll-snap-type: x proximity` caused the first card to stick flush against the left boundary when scrolled, ignoring container padding.
* **Solution:** Applied `scroll-padding-left: 16px` to `.tasks-container` in [`style.css`](file:///d:/003_Coding/newkanvu/style.css), aligning the snap port with the container padding box.

---

## 6. Environment & Configuration

### Backend (`kanvu-api/.env`)
```ini
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=your_password
DB_DATABASE=kanvu

JWT_SECRET=your_secure_random_jwt_secret_key
JWT_EXPIRES_IN=15m

NODE_ENV=development
PORT=3000

FRONTEND_URL=http://localhost:5500
```

### Frontend (`newkanvu/config.js`)
```javascript
const KANVU_CONFIG = {
    apiUrl: 'http://localhost:3000'
};
```

---

## 7. Local Development Guide

### Running the Backend
```bash
cd kanvu-api/kanvu-api
npm install
npm run start:dev
```
Backend starts on `http://localhost:3000`.

### Running the Frontend
Serve `newkanvu/` using any static HTTP server (Live Server, `npx serve`, or Python):
```bash
cd newkanvu
npx serve -l 5500
```
Open `http://localhost:5500` in your browser.

