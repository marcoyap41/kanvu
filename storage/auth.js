class LoadingIndicator {
    constructor() {
        this.count = 0;
        this.bar = null;
    }
    _getBar() {
        if (!this.bar && typeof document !== 'undefined') {
            this.bar = document.getElementById('global-loader');
            if (!this.bar && document.body) {
                this.bar = document.createElement('div');
                this.bar.id = 'global-loader';
                this.bar.className = 'global-loader';
                document.body.prepend(this.bar);
            }
        }
        return this.bar;
    }
    start() {
        this.count++;
        const bar = this._getBar();
        if (bar) bar.classList.add('active');
    }
    stop() {
        this.count = Math.max(0, this.count - 1);
        if (this.count === 0) {
            const bar = this._getBar();
            if (bar) bar.classList.remove('active');
        }
    }
}
if (typeof window !== 'undefined') {
    window.loadingIndicator = window.loadingIndicator || new LoadingIndicator();
}

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
        this.justVerified = false;
        this.justOAuthSignedIn = false;
        this.verifyError = null;
        this.HINT_KEY = 'kanban-session'; // "this browser has signed in before", so guests never call the server on load
    }

    get enabled() { return !!this.apiUrl; }

    // True when this browser signed in before, is returning from OAuth, or is opening an email verification link.
    hasSessionHint() {
        const hash = typeof location !== 'undefined' ? location.hash : '';
        const back = hash.includes('auth=success') || /(?:^|[#&])verify=[^&]+/.test(hash);
        return this._hint() || back;
    }
    get signedIn() { return !!this.user; }

    // ---- Session ----
    // Returns the user if a session exists, null if not. Throws (code NETWORK) if the server can't be reached.
    async restoreSession() {
        if (!this.enabled) return null;
        const hash = typeof location !== 'undefined' ? location.hash : '';
        const authErrMatch = hash.match(/(?:^|[#&])auth_error=([^&]+)/);
        if (authErrMatch) {
            this.verifyError = decodeURIComponent(authErrMatch[1]);
            history.replaceState(null, '', location.pathname + location.search);
            return null;
        }
        const verifyMatch = hash.match(/(?:^|[#&])verify=([^&]+)/);
        if (verifyMatch) {
            const token = decodeURIComponent(verifyMatch[1]);
            history.replaceState(null, '', location.pathname + location.search);
            try {
                const user = await this.verifyEmail(token);
                this.justVerified = true;
                return user;
            } catch (e) {
                if (e.code === 'NETWORK') throw e;
                this.verifyError = e.message || 'This verification link is invalid or has expired.';
                return null;
            }
        }
        if (hash.includes('auth=success')) { // came back from Google/GitHub sign-in
            const ticketMatch = hash.match(/(?:^|[#&])ticket=([^&]+)/);
            this._setHint(true);
            history.replaceState(null, '', location.pathname + location.search);
            if (ticketMatch) {
                try {
                    const user = await this._authCall('/auth/oauth/exchange', {
                        ticket: decodeURIComponent(ticketMatch[1]),
                    });
                    this.justOAuthSignedIn = true;
                    return user;
                } catch (e) {
                    if (e.code === 'NETWORK') throw e;
                    // Fall through to cookie-based refresh if ticket exchange failed
                }
            }
            const ok = await this.refresh();
            if (ok) this.justOAuthSignedIn = true;
            return ok ? this.user : null;
        }
        if (!this._hint()) return null;
        const ok = await this.refresh();
        return ok ? this.user : null;
    }

    // Sign-up step 1: the server emails a verification link. No session yet.
    // Resolves to { status: 'verification_sent', email, expiresInMinutes }.
    async register(email, password, name) {
        return this._publicCall('/auth/register', { email, password, name: name || undefined });
    }

    // Sign-up step 2: the token from the emailed link (#verify=...). Creates the account and signs in.
    async verifyEmail(token) {
        return this._authCall('/auth/verify-email', { token });
    }

    // "Resend the email". Throws with .status 429 and .data.retryAfter (seconds) when rate limited.
    async resendVerification(email) {
        return this._publicCall('/auth/resend-verification', { email });
    }

    // Throws with .data.code === 'EMAIL_NOT_VERIFIED' for a sign-up whose link wasn't clicked yet (the server resends it)
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
            if (typeof window !== 'undefined' && window.loadingIndicator) window.loadingIndicator.start();
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
            })().finally(() => {
                this._refreshing = null;
                if (typeof window !== 'undefined' && window.loadingIndicator) window.loadingIndicator.stop();
            });
        }
        return this._refreshing;
    }

    // ---- Authenticated API calls ----
    // Resolves to the parsed JSON body (null for 204). Throws Error with .code = NETWORK | AUTH | HTTP and .status.
    async request(method, path, body) {
        if (typeof window !== 'undefined' && window.loadingIndicator) window.loadingIndicator.start();
        try {
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
            const text = await res.text();
            return text ? JSON.parse(text) : null;
        } finally {
            if (typeof window !== 'undefined' && window.loadingIndicator) window.loadingIndicator.stop();
        }
    }

    // ---- Internals ----
    // Unauthenticated POST to an /auth route. Resolves to the JSON body.
    async _publicCall(path, body) {
        if (typeof window !== 'undefined' && window.loadingIndicator) window.loadingIndicator.start();
        try {
            let res;
            try {
                res = await fetch(this.apiUrl + path, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'include'
                });
            } catch (e) {
                throw this._error('Cannot reach the server', 'NETWORK');
            }
            if (!res.ok) throw await this._httpError(res);
            if (res.status === 204) return null;
            const text = await res.text();
            return text ? JSON.parse(text) : null;
        } finally {
            if (typeof window !== 'undefined' && window.loadingIndicator) window.loadingIndicator.stop();
        }
    }

    // Same, for routes that answer { accessToken, user } and set the refresh cookie
    async _authCall(path, body) {
        const data = await this._publicCall(path, body);
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
        let data = null;
        try {
            data = await res.json();
            if (data && data.message) message = Array.isArray(data.message) ? data.message.join(', ') : data.message;
        } catch (e) { /* no JSON body */ }
        const err = this._error(message, res.status === 401 ? 'AUTH' : 'HTTP', res.status);
        err.data = data;
        return err;
    }
}
