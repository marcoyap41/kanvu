# Storage adapter contract

`Kanvu` never touches localStorage or `fetch` directly for boards. It talks to `this.storage`, which is either
`LocalStorageAdapter` (draft on sessionStorage, `mode: 'draft'`) or `ApiAdapter` (account mode). Swap it with `kanban.setStorage(adapter)`.

All methods are `async` unless noted. A failed write must **throw** an `Error` with a readable message; the app shows it in a toast.

| Method | Purpose |
|---|---|
| `loadAll()` | `{ boards: {id: board}, order: [id], trash: {id: board + deletedAt} }` |
| `saveBoards(changed, removed)` | `changed = {id: board}` is created/updated, `removed = [id]` deleted. Return the full latest `{id: board}` map, or `null` to keep the app's own copy. **Serialize `changed` before the first `await`**: the app keeps editing the same objects |
| `deleteBoard(id)` | remove a board without trashing it (local adapter only) |
| `setOrder(ids)` | persist the board order |
| `trashBoard(board)` | move to trash (copy first, then remove). Returns the trash entry (board + `deletedAt`) |
| `restoreBoard(id)` | returns the restored board or `null` |
| `purgeBoard(id)` | delete one trashed board forever |
| `emptyTrash()` | delete every trashed board forever |
| `getCurrentBoardId()` / `setCurrentBoardId(id)` | **synchronous**. Which board is open in this session |
| `newBoardId(name)` *(optional)* | id format for new boards. Account mode returns a UUID |
| `onExternalChange(handler)` *(optional)* | call `handler()` when the data changed elsewhere; return an unsubscribe function. The API adapter has none |

Appearance settings (theme, layout, glass, autosave) and wallpaper go through `prefs` (`storage/prefs.js`) and `ApiAdapter` (`storage/api-adapter.js`), syncing to the server in account mode and staying in-memory/sessionStorage in draft mode. Zero data is stored in `localStorage`.
