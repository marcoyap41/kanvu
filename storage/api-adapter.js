/**
 * ApiAdapter: account mode. Boards live on the server (NestJS + PostgreSQL).
 * Same methods as LocalStorageAdapter, so the rest of the app doesn't know the difference.
 * Routes are documented in docs/API_CONTRACT.md.
 */
class ApiAdapter {
    constructor(auth) {
        this.mode = 'account';
        this.auth = auth;
        this.CURRENT_KEY = 'kanban-account-current-board-id'; // separate from guest mode's key
    }

    // Account boards use UUIDs (the server stores the id the client sends)
    newBoardId() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    // GET /boards -> { boards: Board[], order: string[], trash: Board[] }
    async loadAll() {
        const data = await this.auth.request('GET', '/boards');
        const byId = (list) => Object.fromEntries((list || []).map(b => [b.id, b]));
        return { boards: byId(data.boards), order: data.order || [], trash: byId(data.trash) };
    }

    // PUT /boards/:id for each changed board (create or update).
    // The server answers with the saved board; its lastModified/createdAt are copied onto the board object
    // the app holds, so the app's timestamps match the server's. Returns null: the app keeps its own cache.
    async saveBoards(changed = {}, removed = []) {
        if (removed.length) throw new Error('Use trashBoard() to delete boards');
        await Promise.all(Object.entries(changed).map(async ([id, board]) => {
            const saved = await this.auth.request('PUT', `/boards/${encodeURIComponent(id)}`, board);
            if (saved) {
                if (saved.lastModified) board.lastModified = saved.lastModified;
                if (saved.createdAt) board.createdAt = saved.createdAt;
            }
        }));
        return null;
    }

    // PUT /board-order { ids }
    async setOrder(ids) {
        await this.auth.request('PUT', '/board-order', { ids });
    }

    // POST /boards/:id/trash with the full board as the body (so unsaved edits of the open board aren't lost)
    // -> the trash entry (board + deletedAt)
    async trashBoard(board) {
        return this.auth.request('POST', `/boards/${encodeURIComponent(board.id)}/trash`, board);
    }

    // POST /boards/:id/restore -> the restored board, or null if it isn't in the trash
    async restoreBoard(id) {
        try {
            return await this.auth.request('POST', `/boards/${encodeURIComponent(id)}/restore`);
        } catch (e) {
            if (e.status === 404) return null;
            throw e;
        }
    }

    // DELETE /boards/:id (only boards that are in the trash)
    async purgeBoard(id) {
        await this.auth.request('DELETE', `/boards/${encodeURIComponent(id)}`);
    }

    // DELETE /trash
    async emptyTrash() {
        await this.auth.request('DELETE', '/trash');
    }

    // Which board is open on this device stays in session
    getCurrentBoardId() {
        try { return sessionStorage.getItem(this.CURRENT_KEY); } catch (e) { return null; }
    }

    setCurrentBoardId(id) {
        try { sessionStorage.setItem(this.CURRENT_KEY, id); } catch (e) { /* not critical */ }
    }

    // No onExternalChange: the server doesn't push changes (reload the page to see edits from another device).

    // One-time migration of guest boards: POST /boards/import { boards: Board[] }
    // -> { idMap: { oldId: newId }, boards: Board[] }
    async importBoards(boards) {
        return this.auth.request('POST', '/boards/import', { boards });
    }

    // ---- Settings API ----

    // GET /settings -> { settings: UserSettings }
    async getSettings() {
        return this.auth.request('GET', '/settings');
    }

    // PATCH /settings (partial update) -> { settings: UserSettings }
    async patchSettings(patch) {
        return this.auth.request('PATCH', '/settings', patch);
    }

    // ---- Wallpaper API ----

    /**
     * Raw fetch helper for binary/multipart requests that can't go through auth.request().
     * Handles 401 by refreshing the token once and retrying.
     */
    async _fetchBinary(method, path, body) {
        if (typeof window !== 'undefined' && window.loadingIndicator) window.loadingIndicator.start();
        try {
            const doFetch = async () => {
                const headers = {};
                if (this.auth.accessToken) headers['Authorization'] = 'Bearer ' + this.auth.accessToken;
                const opts = { method, headers, credentials: 'include' };
                if (body) opts.body = body;
                return fetch(this.auth.apiUrl + path, opts);
            };
            let res = await doFetch();
            if (res.status === 401) {
                const renewed = await this.auth.refresh();
                if (!renewed) {
                    if (this.auth.onSessionLost) this.auth.onSessionLost();
                    throw new Error('Session expired');
                }
                res = await doFetch();
            }
            return res;
        } finally {
            if (typeof window !== 'undefined' && window.loadingIndicator) window.loadingIndicator.stop();
        }
    }

    // GET /settings/wallpaper -> Blob, or null if no wallpaper is set (404)
    async getWallpaper() {
        const res = await this._fetchBinary('GET', '/settings/wallpaper');
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`Wallpaper fetch failed (${res.status})`);
        return res.blob();
    }

    // PUT /settings/wallpaper (multipart/form-data) -> { wallpaperVersion }
    async putWallpaper(blob, filename = 'wallpaper.jpg') {
        const form = new FormData();
        form.append('file', blob, filename);
        const res = await this._fetchBinary('PUT', '/settings/wallpaper', form);
        if (!res.ok) throw new Error(`Wallpaper upload failed (${res.status})`);
        return res.json(); // { wallpaperVersion }
    }

    // DELETE /settings/wallpaper
    async deleteWallpaper() {
        return this.auth.request('DELETE', '/settings/wallpaper');
    }
}
