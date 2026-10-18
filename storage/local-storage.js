/**
 * LocalStorageAdapter: boards kept in browser storage. Two uses:
 *  - guest  (default, localStorage): the app has no backend (config.js apiUrl is empty)
 *  - draft  (sessionStorage): the app requires an account. Signed out, the user works on a temporary draft
 *           that survives a reload or the Google/GitHub redirect in this tab and vanishes when the tab closes.
 *
 * Every storage adapter (this one, ApiAdapter) implements the same contract, so the app
 * never touches localStorage or fetch for board data directly. See docs/STORAGE_ADAPTER.md.
 *
 * Board shape: { id, name, tasks: [], columns: [], lastModified, createdAt }
 */
class LocalStorageAdapter {
    constructor(store = sessionStorage, options = {}) {
        this.store = store;
        this.mode = options.draft !== undefined ? (options.draft ? 'draft' : 'guest') : 'draft';
        this.KEYS = {
            boards: 'kanban-saved-boards',
            backup: 'kanban-saved-boards-backup',
            order: 'kanban-board-order',
            trash: 'kanban-trash-boards',
            current: 'kanban-current-board-id'
        };
    }

    // ---- Read everything once at startup ----
    // Returns { boards: {id: board}, order: [id], trash: {id: board + deletedAt} }
    async loadAll() {
        return { boards: this._readBoards() || {}, order: this._readOrder(), trash: this._readTrash() };
    }

    // ---- Boards ----
    // Merge-on-write. Never writes a whole in-memory copy over storage: it re-reads the latest data,
    // applies only what this tab changed, then saves, so an old tab can't wipe boards made in another tab.
    //   changed = { id: board } boards created or edited
    //   removed = [id]          boards deleted on purpose
    // Returns the full latest { id: board } map, or throws if the write fails.
    async saveBoards(changed = {}, removed = []) {
        const latest = this._readBoards() || {};
        Object.keys(changed).forEach(id => { latest[id] = changed[id]; });
        removed.forEach(id => { delete latest[id]; });
        this._write(this.KEYS.boards, latest);
        return latest;
    }

    async deleteBoard(id) {
        await this.saveBoards({}, [id]);
    }

    // ---- Board order ----
    async setOrder(ids) {
        this._write(this.KEYS.order, ids);
    }

    // ---- Trash ----
    // Copies the board to the trash FIRST, then removes it from the boards, so a failed write can never lose it.
    // Returns the trash entry (board + deletedAt).
    async trashBoard(board) {
        const entry = { ...board, deletedAt: new Date().toISOString() };
        const trash = this._readTrash();
        trash[board.id] = entry;
        this._write(this.KEYS.trash, trash);
        try {
            await this.deleteBoard(board.id);
        } catch (e) {
            delete trash[board.id]; // undo the trash copy so the board isn't in both places
            try { this._write(this.KEYS.trash, trash); } catch (_) {}
            throw e;
        }
        return entry;
    }

    // Returns the restored board, or null if it isn't in the trash.
    async restoreBoard(id) {
        const trash = this._readTrash();
        const item = trash[id];
        if (!item) return null;
        const { deletedAt, ...board } = item;
        await this.saveBoards({ [id]: board }); // back into boards first, then out of the trash
        delete trash[id];
        try { this._write(this.KEYS.trash, trash); } catch (e) { console.error('Could not clear trash entry:', e); }
        return board;
    }

    async purgeBoard(id) {
        const trash = this._readTrash();
        delete trash[id];
        this._write(this.KEYS.trash, trash);
    }

    async emptyTrash() {
        this._write(this.KEYS.trash, {});
    }

    // ---- Which board is open on this device (always local, in every mode) ----
    getCurrentBoardId() {
        try { return this.store.getItem(this.KEYS.current); } catch (e) { return null; }
    }

    setCurrentBoardId(id) {
        try { this.store.setItem(this.KEYS.current, id); } catch (e) { /* not critical */ }
    }

    // ---- Other tabs changed the data ----
    // Calls handler() when another tab writes boards, order or trash. Returns an unsubscribe function.
    onExternalChange(handler) {
        const listener = (e) => {
            if (e.storageArea !== this.store) return;
            const k = e.key;
            if (k === null || k === this.KEYS.boards || k === this.KEYS.order || k === this.KEYS.trash) handler();
        };
        window.addEventListener('storage', listener);
        return () => window.removeEventListener('storage', listener);
    }

        // Removes everything this adapter stored (empties the draft after sign in, sign out or discard)
    clear() {
        Object.values(this.KEYS).forEach((k) => { try { this.store.removeItem(k); } catch (e) { /* ignore */ } });
    }

    // ---- Internals ----
    // Unreadable data is copied to a backup key first so it can never be lost silently.
    _readBoards() {
        let raw = null;
        try {
            raw = this.store.getItem(this.KEYS.boards);
            const parsed = raw ? JSON.parse(raw) : null;
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (e) {
            console.error('Saved boards are unreadable:', e);
            try { if (raw) this.store.setItem(this.KEYS.backup, raw); } catch (_) {}
            return null;
        }
    }

    _readOrder() {
        try {
            const saved = JSON.parse(this.store.getItem(this.KEYS.order));
            return Array.isArray(saved) ? saved : [];
        } catch (e) {
            return [];
        }
    }

    _readTrash() {
        try {
            const t = JSON.parse(this.store.getItem(this.KEYS.trash));
            return t && typeof t === 'object' && !Array.isArray(t) ? t : {};
        } catch (e) {
            return {};
        }
    }

    _write(key, value) {
        try {
            this.store.setItem(key, JSON.stringify(value));
        } catch (e) {
            throw new Error('browser storage is full or blocked');
        }
    }
}
