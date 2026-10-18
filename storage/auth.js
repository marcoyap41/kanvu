/**
 * AuthClient: talks to the backend's /auth routes and sends every API request with the access token.
 *
 * - The short-lived access token lives only in memory (never localStorage).
 * - The long-lived refresh token is an httpOnly cookie set by the server (JavaScript can't read it).
 * - On a 401 it silently asks POST /auth/refresh for a new access token and retries once.
 *
 * Routes it expects are in docs/API_CONTRACT.md.
 */
class AuthClient {
    constructor({ apiUrl }) {
        this.apiUrl = (apiUrl || '').replace(/\/+$/, '');
        this.accessToken = null;
        this.user = null;
        this.onSessionLost = null; // set by the UI: called when the session can't be renewed
        this._refreshing = null;
        this.HINT_KEY = 'kanban-session'; // "this browser has signed in before", so guests never call the server on load
    }

    get enabled() { return !!this.apiUrl; }

    // True when this browser signed in before (or is returning from Google/GitHub). Used to show a loading screen at startup.
    hasSessionHint() {
        const back = typeof location !== 'undefined' && location.hash.includes('auth=success');
        return this._hint() || back;
    }
    get signedIn() { return !!this.user; }

    // ---- Session ----
    // Returns the user if a session exists, null if not. Throws (code NETWORK) if the server can't be reached.
    async restoreSession() {
        if (!this.enabled) return null;
        const hash = typeof location !== 'undefined' ? location.hash : '';
        if (hash.includes('auth=success')) { // came back from Google/GitHub sign-in
            this._setHint(true);
            history.replaceState(null, '', location.pathname + location.search);
        }
        if (!this._hint()) return null;
        const ok = await this.refresh();
        return ok ? this.user : null;
    }

    async register(email, password, name) {
        return this._authCall('/auth/register', { email, password, name: name || undefined });
    }

    async login(email, password) {
        return this._authCall('/auth/login', { email, password });
    }

    async logout() {
        try { await fetch(this.apiUrl + '/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) { /* signing out locally anyway */ }
        this._clear();
    }

    // OAuth is a full-page redirect: the server sends the user to the provider and back to the frontend.
    oauthUrl(provider) {
        return `${this.apiUrl}/auth/${provider}`;
    }

    // Gets a new access token from the refresh cookie. Several callers at once share one request.
    // true = signed in, false = no valid session. Throws NETWORK if the server is unreachable.
    refresh() {
        if (!this._refreshing) {
            this._refreshing = (async () => {
                let res;
                try {
                    res = await fetch(this.apiUrl + '/auth/refresh', { method: 'POST', credentials: 'include' });
                } catch (e) {
                    throw this._error('Cannot reach the server', 'NETWORK');
                }
                if (!res.ok) { this._clear(); return false; }
                const data = await res.json();
                this.accessToken = data.accessToken;
                this.user = data.user;
                this._setHint(true);
                return true;
            })().finally(() => { this._refreshing = null; });
        }
        return this._refreshing;
    }

    // ---- Authenticated API calls ----
    // Resolves to the parsed JSON body (null for 204). Throws Error with .code = NETWORK | AUTH | HTTP and .status.
    async request(method, path, body) {
        const payload = body !== undefined ? JSON.stringify(body) : undefined; // serialized now, so later edits can't change what is sent
        const send = async () => {
            const headers = {};
            if (payload !== undefined) headers['Content-Type'] = 'application/json';
            if (this.accessToken) headers['Authorization'] = 'Bearer ' + this.accessToken;
            try {
                return await fetch(this.apiUrl + path, { method, headers, body: payload, credentials: 'include' });
            } catch (e) {
                throw this._error('Cannot reach the server', 'NETWORK');
            }
        };

        let res = await send();
        if (res.status === 401) {
            const renewed = await this.refresh();
            if (!renewed) {
                if (this.onSessionLost) this.onSessionLost();
                throw this._error('Session expired. Please sign in again', 'AUTH', 401);
            }
            res = await send();
        }
        if (!res.ok) throw await this._httpError(res);
        if (res.status === 204) return null;
        return res.json();
    }

    // ---- Internals ----
    async _authCall(path, body) {
        let res;
        try {
            res = await fetch(this.apiUrl + path, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'include'
            });
        } catch (e) {
            throw this._error('Cannot reach the server', 'NETWORK');
        }
        if (!res.ok) throw await this._httpError(res);
        const data = await res.json();
        this.accessToken = data.accessToken;
        this.user = data.user;
        this._setHint(true);
        return this.user;
    }

    _clear() {
        this.accessToken = null;
        this.user = null;
        this._setHint(false);
    }

    _hint() { try { return localStorage.getItem(this.HINT_KEY) === '1'; } catch (e) { return false; } }
    _setHint(on) { try { on ? localStorage.setItem(this.HINT_KEY, '1') : localStorage.removeItem(this.HINT_KEY); } catch (e) {} }

    _error(message, code, status) {
        const e = new Error(message);
        e.code = code;
        e.status = status;
        return e;
    }

    // NestJS errors look like { statusCode, message: string | string[], error }
    async _httpError(res) {
        let message = `Request failed (${res.status})`;
        try {
            const data = await res.json();
            if (data && data.message) message = Array.isArray(data.message) ? data.message.join(', ') : data.message;
        } catch (e) { /* no JSON body */ }
        return this._error(message, res.status === 401 ? 'AUTH' : 'HTTP', res.status);
    }
}
