/**
 * SettingsManager: appearance/behaviour settings (theme, density, layout, autosave, glass...).
 * In account mode, settings are loaded from the server via GET /settings and synced via PATCH /settings.
 * In draft mode (signed out), settings live in memory and are temporarily preserved in sessionStorage for the tab.
 * No data is stored in localStorage.
 */
class SettingsManager {
    constructor() {
        this._auth = null;
        this._paused = false;
        this._pending = {};
        this._debounceTimer = null;

        this._DEFAULTS = {
            'theme': 'black',
            'density': 'comfortable',
            'view': 'columns',
            'column-layout': '4',
            'header-blur': 'false',
            'glass-lanes': 'false',
            'glass-cards': 'false',
            'glass-opacity': '55',
            'header-blur-amount': '16',
            'stage-blur-amount': '10',
            'autosave': 'false'
        };

        // Maps frontend short-key -> server key name
        this._KEY_MAP = {
            'view': 'layout',
            'column-layout': 'columnLayout',
            'header-blur': 'headerBlur',
            'glass-lanes': 'glassLanes',
            'glass-cards': 'glassCards',
            'glass-opacity': 'glassOpacity',
            'header-blur-amount': 'headerBlurAmount',
            'stage-blur-amount': 'stageBlurAmount'
        };

        // Reverse map: server key -> local key
        this._REV_MAP = Object.fromEntries(Object.entries(this._KEY_MAP).map(([l, s]) => [s, l]));

        // In-memory cache seeded from defaults and any sessionStorage draft
        this._cache = { ...this._DEFAULTS };
        for (const key of Object.keys(this._DEFAULTS)) {
            try {
                const v = sessionStorage.getItem('kanban-' + key);
                if (v !== null) this._cache[key] = v;
            } catch (e) {}
        }
    }

    get defaults() {
        return { ...this._DEFAULTS };
    }

    /**
     * Returns setting value for `key` as a string (matching old prefs API).
     */
    get(key) {
        if (this._cache[key] !== undefined && this._cache[key] !== null) {
            return String(this._cache[key]);
        }
        const def = this._DEFAULTS[key];
        return def !== undefined ? String(def) : null;
    }

    /**
     * Updates `key` in memory (and sessionStorage when in draft mode).
     * In account mode, queues a debounced PATCH /settings.
     */
    set(key, value) {
        this._cache[key] = value;

        // In draft mode, keep settings in sessionStorage for this tab only
        if (!this._auth) {
            try { sessionStorage.setItem('kanban-' + key, String(value)); } catch (e) {}
        }

        // Queue a server PATCH if in account mode and not paused
        if (this._auth && !this._paused) {
            const serverKey = this._KEY_MAP[key] || key;
            this._pending[serverKey] = value;
            this._schedulePatch();
        }
    }

    /** Enables server syncing after sign-in. */
    setAuth(auth) {
        this._auth = auth;
    }

    /** Resets settings and stops server syncing on sign-out. */
    clearAuth() {
        this._auth = null;
        this._pending = {};
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
        this._cache = { ...this._DEFAULTS };
        for (const key of Object.keys(this._DEFAULTS)) {
            try { sessionStorage.removeItem('kanban-' + key); } catch (e) {}
        }
    }

    /**
     * Fetches GET /settings, merges server values into cache,
     * and returns the server settings object for UI application.
     */
    async loadFromServer() {
        if (!this._auth) throw new Error('SettingsManager: no auth set');
        const data = await this._auth.request('GET', '/settings');
        const serverSettings = (data && data.settings) ? data.settings : (data || {});

        for (const [serverKey, value] of Object.entries(serverSettings)) {
            if (serverKey === 'wallpaperVersion') continue;
            const localKey = this._REV_MAP[serverKey] || serverKey;
            this._cache[localKey] = value != null ? String(value) : null;
        }

        return serverSettings;
    }

    pause() { this._paused = true; }

    resume() {
        this._paused = false;
        if (this._auth && Object.keys(this._pending).length > 0) {
            this._schedulePatch();
        }
    }

    _schedulePatch() {
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this._flushPatch(), 600);
    }

    async flush() {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
        await this._flushPatch();
    }

    async _flushPatch() {
        this._debounceTimer = null;
        if (!this._auth || Object.keys(this._pending).length === 0) return;
        const patch = this._pending;
        this._pending = {};

        // Cast values to exact types expected by UpdateSettingsDto
        const payload = {};
        for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) continue;
            if (k === 'columnLayout' || k === 'glassOpacity' || k === 'headerBlurAmount' || k === 'stageBlurAmount') {
                const num = parseInt(v, 10);
                if (!isNaN(num)) payload[k] = num;
            } else if (k === 'headerBlur' || k === 'glassLanes' || k === 'glassCards' || k === 'autosave') {
                payload[k] = Boolean(v === true || v === 'true');
            } else {
                payload[k] = v;
            }
        }

        try {
            await this._auth.request('PATCH', '/settings', payload);
        } catch (e) {
            console.warn('prefs: failed to PATCH /settings', e);
        }
    }
}

// Single global instance (plain script, no module system)
const prefs = new SettingsManager();
