# Kanvu API contract

What the frontend (`storage/auth.js`, `storage/api-adapter.js`) expects from the NestJS backend.
`mock-server/server.js` implements every route below in memory, so you can compare your backend against it.

## Conventions
- JSON in, JSON out. Dates are ISO 8601 strings.
- Every route except `/auth/*` needs `Authorization: Bearer <accessToken>`; a missing or expired token is `401`.
- Errors use Nest's default shape `{ statusCode, message: string | string[], error }`. The frontend shows `message` to the user.
- The frontend sends `credentials: 'include'` on every request. CORS must allow the frontend origin **with credentials** (`origin: FRONTEND_URL, credentials: true`, never `*`).

## Board shape
```json
{ "id": "uuid", "name": "string", "tasks": [], "columns": [], "createdAt": "ISO", "lastModified": "ISO" }
```
`tasks` and `columns` are opaque arrays owned by the frontend; the simplest backend stores them as `jsonb` (`boards` table: `id uuid pk`, `user_id`, `name`, `tasks jsonb`, `columns jsonb`, `position int`, `deleted_at timestamptz null`, `created_at`, `last_modified`). Validate that they are arrays; do not validate their contents.
The server sets `lastModified` to `now()` on every write and returns it. The client copies it onto its board.

## Auth
| Route | Body | Response |
|---|---|---|
| `POST /auth/register` | `{ email, password (min 8), name? }` | `201 { accessToken, user }` + refresh cookie. `409` if the email exists |
| `POST /auth/login` | `{ email, password }` | `200 { accessToken, user }` + refresh cookie. `401` if wrong |
| `POST /auth/refresh` | none (reads cookie) | `200 { accessToken, user }` + a **new** refresh cookie. `401` if missing or invalid |
| `POST /auth/logout` | none | `204`, clears the cookie, revokes the refresh token |
| `GET /auth/google`, `GET /auth/github` | none | Redirects to the provider (see OAuth) |

`user` is `{ id, email, name }`. The frontend uses `user.id` (import flag) and `user.email`/`name` (avatar).

- **Access token:** JWT, short life (15 min). The frontend keeps it in memory only.
- **Refresh token:** long life (30 days), `httpOnly` cookie, rotated on every refresh. Store a hash of it server-side so logout can revoke it.
- **Cookie flags:** local dev `SameSite=Lax`. Production with the frontend on Vercel and the API on another domain: `SameSite=None; Secure`.

## OAuth
The frontend navigates the whole page to `GET {apiUrl}/auth/google` (or `github`). Your Passport callback finds or creates the user (table `oauth_accounts(provider, provider_user_id, user_id)`), sets the **refresh cookie**, and redirects to `FRONTEND_URL/#auth=success`. On load the frontend sees that hash, calls `POST /auth/refresh`, and starts in account mode. No token is ever put in a URL.

## Boards
All routes only ever touch the logged-in user's boards. A board belonging to someone else is `404`.

| Route | Body | Response |
|---|---|---|
| `GET /boards` | none | `200 { boards: Board[], order: string[], trash: (Board & { deletedAt })[] }`. `boards` excludes trashed boards and is sorted by `order` |
| `PUT /boards/:id` | full Board | `200 Board`. **Upsert**: the client generates the UUID, so create and update are the same call. `409` if the board is in the trash. `400` if `name` is empty or `tasks`/`columns` are not arrays. New boards are appended to the order |
| `PUT /board-order` | `{ ids: string[] }` | `204`. Ignore unknown or trashed ids |
| `POST /boards/:id/trash` | full Board | `200 Board & { deletedAt }`. Saves the body first (the open board may have unsaved edits), then sets `deleted_at`, and removes it from the order |
| `POST /boards/:id/restore` | none | `200 Board`. `404` if it is not in the trash. Appended to the end of the order |
| `DELETE /boards/:id` | none | `204`. Permanent. Only for boards already in the trash (`409` otherwise) |
| `DELETE /trash` | none | `204`. Permanently deletes every trashed board of the user |
| `POST /boards/import` | `{ boards: Board[] }` | `201 { idMap: { [oldId]: newId }, boards: Board[] }`. Creates each board with a **new UUID** (old guest ids like `board_work_1712...` are not valid), keeps `createdAt`, appends in the given order |

Nest tips: declare `PUT /board-order`, `DELETE /trash` and `POST /boards/import` in a controller where they cannot be shadowed by `:id` routes (the paths above already avoid that, but keep `import` above `:id` if you nest it under `/boards`).

## Settings and Wallpaper
Appearance configurations and wallpaper images are stored server-side per user account.

| Route | Body | Response |
|---|---|---|
| `GET /settings` | none | `200 { settings: UserSettings }`. Returns current theme, density, layout, blur, opacity, autosave settings |
| `PATCH /settings` | `UpdateSettingsDto` | `200 { settings: UserSettings }`. Partial update of settings |
| `GET /settings/wallpaper` | none | `200` Streamable binary file (`Content-Type: image/*`), or `404` if none set |
| `PUT /settings/wallpaper` | `multipart/form-data` with `file` (max 4MB) | `200 { wallpaperVersion: string }`. Uploads/updates wallpaper image |
| `DELETE /settings/wallpaper` | none | `200` / `204`. Removes custom wallpaper |

### UserSettings shape:
```json
{
  "theme": "black | grey | white",
  "density": "comfortable | compact | dense",
  "columnLayout": 3 | 4 | 5,
  "layout": "columns | lanes",
  "headerBlur": true | false,
  "glassLanes": true | false,
  "glassCards": true | false,
  "glassOpacity": 20-95,
  "headerBlurAmount": 0-30,
  "stageBlurAmount": 0-30,
  "autosave": true | false,
  "wallpaperVersion": "ISO string"
}
```

## Not in v2 (future enhancements)
- Conflict detection between devices (two devices editing one board is last-write-wins). Later: send the `lastModified` you loaded and answer `409` when it is older.
- Real-time WebSockets / SSE for pushing changes across devices.

