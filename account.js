/**
 * AccountUI: the account button (top right of the header bar), the "not saved" banner, the sign in / register
 * dialog, sign out, and the import of the signed-out draft into the account.
 *
 * Draft mode   = LocalStorageAdapter on sessionStorage (signed out: nothing can be saved)
 * Account mode = ApiAdapter (signed in)
 * Switching is just kanban.setStorage(adapter): the board code never knows which one it is using.
 */
class AccountUI {
    constructor(kanban, auth, makeDraft) {
        this.kanban = kanban;
        this.auth = auth;
        this.makeDraft = makeDraft; // () => a draft adapter on this tab's sessionStorage
        this.authMode = 'login'; // 'login' | 'register' | 'verify'
        this.verifyPendingEmail = '';
        this._resendTimer = null;
        this._expiredShown = false;
    }

    async start() {
        this.wrap = document.getElementById('account-wrap');
        this.button = document.getElementById('account-button');
        this.banner = document.getElementById('draft-banner');
        if (!this.wrap || !this.button) return;
        if (!this.auth.enabled) { this.wrap.hidden = true; return; } // no apiUrl in config.js: guest-only app

        this.menu = document.getElementById('account-menu');
        this.button.addEventListener('click', () => this.onButtonClick());
        const bannerSignIn = document.getElementById('draft-banner-signin');
        if (bannerSignIn) bannerSignIn.addEventListener('click', () => this.openModal('login'));

        document.getElementById('account-signout').addEventListener('click', () => this.signOut());
        document.addEventListener('click', (e) => { if (!e.target.closest('#account-wrap')) this.closeMenu(); });
        window.addEventListener('hashchange', () => this.handleVerifyHash());
        this.auth.onSessionLost = () => this.sessionExpired();
        this.render();

        if (this.auth.justVerified && this.auth.user) {
            this.auth.justVerified = false;
            this.kanban.showToast(`Email verified! Signed in as ${this.auth.user.email}`, 'success');
        } else if (this.auth.verifyError) {
            const err = this.auth.verifyError;
            this.auth.verifyError = null;
            this.kanban.showToast(err, 'error');
            this.openModal('login');
            this.showError(err);
        }

        // Came back signed in (OAuth redirect or verification link keeps the draft in this tab): offer to add it to the account
        if (this.inAccountMode()) {
            try {
                const status = await this.offerImport();
                if (status === 'imported') await this.kanban.setStorage(this.kanban.storage); // reload with the new boards
                if (status === 'imported' || status === 'discarded' || status === 'empty') this.makeDraft().clear();
            } catch (e) { console.error(e); }
        }
    }

    async handleVerifyHash() {
        const hash = typeof location !== 'undefined' ? location.hash : '';
        const match = hash.match(/(?:^|[#&])verify=([^&]+)/);
        if (!match) return;
        const token = decodeURIComponent(match[1]);
        history.replaceState(null, '', location.pathname + location.search);
        try {
            await this.auth.verifyEmail(token);
            this.closeModal();
            await this.afterAuth();
        } catch (e) {
            const msg = e.message || 'This verification link is invalid or has expired.';
            this.kanban.showToast(msg, 'error');
            this.openModal('login');
            this.showError(msg);
        }
    }

    inAccountMode() {
        return this.kanban.storage.mode === 'account' && this.auth.signedIn;
    }

    // ---- Header button ----
    render() {
        if (!this.button) return;
        if (this.banner) this.banner.hidden = this.kanban.storage.mode !== 'draft';
        if (this.inAccountMode()) {
            const u = this.auth.user;
            this.button.textContent = ((u.name || u.email || '?')[0] || '?').toUpperCase();
            this.button.className = 'btn account-avatar';
            this.button.title = u.email;
            this.button.setAttribute('aria-label', 'Account menu');
            document.getElementById('account-email').textContent = u.email;
        } else {
            this.button.textContent = this.kanban.isDraft() ? 'Sign in to save' : 'Sign in';
            this.button.className = 'btn btn-secondary';
            this.button.title = 'Sign in to keep your boards in your account';
            this.button.setAttribute('aria-label', 'Sign in');
            this.closeMenu();
        }
    }

    onButtonClick() {
        if (this.inAccountMode()) this.menu.hidden = !this.menu.hidden;
        else this.openModal('login');
    }

    closeMenu() {
        if (this.menu) this.menu.hidden = true;
    }

    // ---- Sign in / register dialog ----
    buildModal() {
        if (document.getElementById('auth-modal')) return;
        const d = document.createElement('div');
        d.id = 'auth-modal';
        d.className = 'modal';
        d.innerHTML = `
            <div class="modal-content modal-small">
                <div class="modal-header">
                    <h2 class="modal-title" id="auth-title"></h2>
                    <button type="button" class="modal-close" id="auth-close" aria-label="Close">×</button>
                </div>
                <div class="modal-body">
                    <div id="auth-form-view">
                        <p id="auth-note" hidden></p>
                        <div class="form-group" id="auth-name-group" hidden>
                            <label class="form-label" for="auth-name">Name (optional)</label>
                            <input class="form-input" id="auth-name" type="text" maxlength="50" autocomplete="name">
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="auth-email">Email</label>
                            <input class="form-input" id="auth-email" type="email" autocomplete="email">
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="auth-password">Password</label>
                            <input class="form-input" id="auth-password" type="password">
                        </div>
                        <p class="auth-error" id="auth-error" role="alert" hidden></p>
                        <button type="button" class="btn auth-submit" id="auth-submit"></button>
                        <div class="auth-divider"><span>or</span></div>
                        <div class="auth-oauth">
                            <button type="button" class="btn btn-secondary" data-oauth="google">Continue with Google</button>
                            <button type="button" class="btn btn-secondary" data-oauth="github">Continue with GitHub</button>
                        </div>
                        <p class="auth-switch"><button type="button" class="link" id="auth-switch"></button></p>
                    </div>
                    <div id="auth-verify-view" hidden>
                        <p id="auth-verify-text" style="margin:0 0 10px;font-size:13.5px;line-height:1.5;color:var(--ink)"></p>
                        <p id="auth-verify-sub" style="margin:0 0 16px;font-size:12.5px;line-height:1.45;color:var(--mute)"></p>
                        <p class="auth-error" id="auth-verify-error" role="alert" hidden></p>
                        <p id="auth-verify-ok" style="margin:0 0 12px;font-size:13px;color:#2F9E44" hidden></p>
                        <button type="button" class="btn auth-submit" id="auth-resend">Resend verification email</button>
                        <p class="auth-switch"><button type="button" class="link" id="auth-back-login">Back to sign in</button></p>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(d);

        d.querySelector('#auth-close').addEventListener('click', () => this.closeModal());
        d.querySelector('#auth-submit').addEventListener('click', () => this.submit());
        d.querySelector('#auth-switch').addEventListener('click', () => this.setAuthMode(this.authMode === 'login' ? 'register' : 'login'));
        d.querySelector('#auth-resend').addEventListener('click', () => this.resendVerification());
        d.querySelector('#auth-back-login').addEventListener('click', () => {
            this._clearResendTimer();
            this.setAuthMode('login');
            if (this.verifyPendingEmail) document.getElementById('auth-email').value = this.verifyPendingEmail;
        });
        d.querySelectorAll('[data-oauth]').forEach(b => b.addEventListener('click', () => this.oauth(b.dataset.oauth)));
        d.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') this.submit(); });
    }

    openModal(mode = 'login', note = '') {
        this.buildModal();
        this.closeMenu();
        this._clearResendTimer();
        this.setAuthMode(mode);
        const n = document.getElementById('auth-note');
        n.textContent = note;
        n.hidden = !note;
        this.showError('');
        document.getElementById('auth-password').value = '';
        document.getElementById('auth-modal').classList.add('show');
        setTimeout(() => document.getElementById('auth-email').focus(), 50);
    }

    closeModal() {
        this._clearResendTimer();
        const m = document.getElementById('auth-modal');
        if (m) m.classList.remove('show');
        this._expiredShown = false;
    }

    setAuthMode(mode) {
        this.authMode = mode;
        const reg = mode === 'register';
        const formView = document.getElementById('auth-form-view');
        const verifyView = document.getElementById('auth-verify-view');
        if (formView) formView.hidden = false;
        if (verifyView) verifyView.hidden = true;
        document.getElementById('auth-title').textContent = reg ? 'Create account' : 'Sign in';
        document.getElementById('auth-submit').textContent = reg ? 'Create account' : 'Sign in';
        document.getElementById('auth-switch').textContent = reg ? 'I already have an account' : 'Create an account';
        document.getElementById('auth-name-group').hidden = !reg;
        document.getElementById('auth-password').autocomplete = reg ? 'new-password' : 'current-password';
        this.showError('');
    }

    showVerifyPending(email, expiresInMinutes = 15, cooldownSeconds = 60, customLead = '') {
        this.buildModal();
        this.authMode = 'verify';
        this.verifyPendingEmail = email;
        document.getElementById('auth-form-view').hidden = true;
        document.getElementById('auth-verify-view').hidden = false;
        document.getElementById('auth-title').textContent = 'Check your email';

        const textEl = document.getElementById('auth-verify-text');
        textEl.textContent = '';
        if (customLead) {
            textEl.textContent = customLead;
        } else {
            textEl.append('We sent a verification link to ');
            const strong = document.createElement('strong');
            strong.textContent = email;
            textEl.append(strong, '. Click the link in that email to activate your account and sign in.');
        }

        document.getElementById('auth-verify-sub').textContent =
            `The link expires in ${expiresInMinutes} minutes. Check your spam folder if you don't see it.`;
        this.showVerifyError('');
        this.showVerifyOk('');
        this._startResendCooldown(cooldownSeconds);
    }

    _clearResendTimer() {
        if (this._resendTimer) {
            clearInterval(this._resendTimer);
            this._resendTimer = null;
        }
    }

    _startResendCooldown(seconds) {
        this._clearResendTimer();
        const btn = document.getElementById('auth-resend');
        if (!btn) return;
        let rem = Math.max(0, Math.ceil(Number(seconds) || 0));
        const update = () => {
            if (rem > 0) {
                btn.disabled = true;
                btn.textContent = `Resend verification email (${rem}s)`;
            } else {
                btn.disabled = false;
                btn.textContent = 'Resend verification email';
                this._clearResendTimer();
            }
        };
        update();
        if (rem > 0) {
            this._resendTimer = setInterval(() => {
                rem -= 1;
                update();
            }, 1000);
        }
    }

    showVerifyError(message) {
        const e = document.getElementById('auth-verify-error');
        if (!e) return;
        e.textContent = message;
        e.hidden = !message;
    }

    showVerifyOk(message) {
        const e = document.getElementById('auth-verify-ok');
        if (!e) return;
        e.textContent = message;
        e.hidden = !message;
    }

    async resendVerification() {
        if (!this.verifyPendingEmail) return;
        const btn = document.getElementById('auth-resend');
        btn.disabled = true;
        btn.classList.add('btn-loading');
        this.showVerifyError('');
        this.showVerifyOk('');
        try {
            const res = await this.auth.resendVerification(this.verifyPendingEmail);
            this.showVerifyOk('A new verification link has been sent to your email.');
            this._startResendCooldown(res?.retryAfter || 60);
        } catch (e) {
            this.showVerifyError(e.message || 'Could not resend verification email.');
            if (e.data && e.data.retryAfter) {
                this._startResendCooldown(e.data.retryAfter);
            } else {
                btn.disabled = false;
            }
        } finally {
            btn.classList.remove('btn-loading');
        }
    }

    showError(message) {
        const e = document.getElementById('auth-error');
        if (!e) return;
        e.textContent = message;
        e.hidden = !message;
    }

    async submit() {
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;
        const name = document.getElementById('auth-name').value.trim();
        if (!email || !password) return this.showError('Enter your email and password.');
        if (this.authMode === 'register' && password.length < 8) return this.showError('Use at least 8 characters for the password.');

        const btn = document.getElementById('auth-submit');
        btn.disabled = true;
        btn.classList.add('btn-loading');
        this.showError('');
        try {
            if (this.authMode === 'register') {
                const res = await this.auth.register(email, password, name);
                btn.disabled = false;
                btn.classList.remove('btn-loading');
                this.showVerifyPending(res?.email || email, res?.expiresInMinutes || 15, 60);
                return;
            }
            await this.auth.login(email, password);
        } catch (e) {
            btn.disabled = false;
            btn.classList.remove('btn-loading');
            if (e.data && e.data.code === 'EMAIL_NOT_VERIFIED') {
                this.showVerifyPending(
                    e.data.email || email,
                    15,
                    e.data.retryAfter || 60,
                    e.message
                );
                return;
            }
            this.showError(e.message);
            return;
        }
        btn.disabled = false;
        btn.classList.remove('btn-loading');
        this.closeModal();
        await this.afterAuth();
    }

    // Google / GitHub: full-page redirect. Unsaved guest edits are saved first.
    async oauth(provider) {
        if (!this.inAccountMode()) await this.kanban.saveCurrentBoard(); // keeps the draft in this tab's session through the redirect
        this.kanban.allowUnload();
        window.location.href = this.auth.oauthUrl(provider);
    }

    // ---- After a successful sign in ----
    async afterAuth() {
        const k = this.kanban;
        if (k.storage.mode === 'account') { // session was renewed after it expired; nothing to reload
            this.render();
            k.showToast('Signed in', 'success');
            return;
        }
        try {
            await k.saveCurrentBoard();                 // keep the latest draft edits in this tab first
            const status = await this.offerImport();    // add the draft to the account, or discard it
            await k.setStorage(new ApiAdapter(this.auth));
            if (status === 'imported' || status === 'discarded' || status === 'empty') this.makeDraft().clear();
        } catch (e) {
            console.error(e);
            await this.auth.logout();
            await k.setStorage(this.makeDraft());
            this.render();
            k.showToast(`Signed in, but your boards could not be loaded: ${e.message}`, 'error');
            return;
        }
        // Sync settings and wallpaper from the server now that we're in account mode
        prefs.setAuth(this.auth);
        try {
            const serverSettings = await prefs.loadFromServer();
            prefs.pause();
            try { k._applySettings(serverSettings); } finally { prefs.resume(); }
            await k.loadWallpaper();
        } catch (e) { console.error('Could not load settings from server:', e); }
        this.render();
        k.showToast(`Signed in as ${this.auth.user.email}`, 'success');
    }

    // ---- Sign out ----
    async signOut() {
        const k = this.kanban;
        this.closeMenu();
        if (!k.isSaved()) {
            const saved = await k.saveCurrentBoard();
            if (!saved) {
                const choice = await this.ask('Sign out?', 'Your latest changes could not be saved to your account. Sign out anyway and lose them?', ['Sign out anyway', 'Stay signed in']);
                if (choice !== 0) return;
            }
        }
        await this.auth.logout();
        prefs.clearAuth(); // stop syncing settings to the server
        k.resetToDefaultSettings();
        const draft = this.makeDraft();
        draft.clear();                  // signing out leaves an empty draft, never the account's boards
        await k.setStorage(draft);
        this.render();
        k.showToast('Signed out', 'info');
    }

    sessionExpired() {
        if (this._expiredShown) return;
        this._expiredShown = true;
        this.render();
        this.kanban.showToast('Session expired. Please sign in again', 'error');
        this.openModal('login', 'Your session expired. Sign in again to keep saving your changes.');
    }

    // ---- Adding the signed-out draft to the account ----
    // Resolves to a status. The caller clears the draft once it is safe to do so:
    //   'imported' | 'discarded' | 'empty' (nothing worth keeping) | 'dismissed' (asked again next time) | 'failed'
    async offerImport() {
        const data = await this.makeDraft().loadAll();
        const ids = data.order.filter(id => data.boards[id]);
        Object.keys(data.boards).forEach(id => { if (!ids.includes(id)) ids.push(id); });
        const boards = ids.map(id => data.boards[id]);
        if (!this.hasContent(boards)) return 'empty';

        const n = boards.length;
        const choice = await this.ask(
            'Add your boards to your account?',
            `${n} board${n === 1 ? '' : 's'} you made while signed out ${n === 1 ? 'is' : 'are'} not saved anywhere yet. Add ${n === 1 ? 'it' : 'them'} to your account?`,
            ['Add to my account', 'Discard']
        );
        if (choice === null) return 'dismissed';
        if (choice === 1) return 'discarded';

        try {
            await new ApiAdapter(this.auth).importBoards(boards);
        } catch (e) {
            this.kanban.showToast(`Import failed: ${e.message}`, 'error');
            return 'failed';
        }
        this.kanban.showToast(`Added ${n} board${n === 1 ? '' : 's'} to your account`, 'success');
        return 'imported';
    }

    // A fresh draft has one empty "Untitled Board"; that isn't worth importing
    hasContent(boards) {
        if (!boards.length) return false;
        if (boards.length > 1) return true;
        const b = boards[0];
        return (b.tasks || []).length > 0 || b.name !== 'Untitled Board';
    }

    // ---- Small choice dialog that returns a promise: the button index, or null if dismissed ----
    ask(title, message, buttons) {
        return new Promise((resolve) => {
            let d = document.getElementById('account-ask');
            if (!d) {
                d = document.createElement('div');
                d.id = 'account-ask';
                d.className = 'modal';
                d.innerHTML = `
                    <div class="modal-content modal-small">
                        <div class="modal-header">
                            <h2 class="modal-title" id="account-ask-title"></h2>
                            <button type="button" class="modal-close" id="account-ask-close" aria-label="Close">×</button>
                        </div>
                        <div class="modal-body">
                            <p id="account-ask-message" style="white-space:pre-line"></p>
                            <div class="auth-oauth" id="account-ask-buttons"></div>
                        </div>
                    </div>`;
                document.body.appendChild(d);
            }
            d.querySelector('#account-ask-title').textContent = title;
            d.querySelector('#account-ask-message').textContent = message;
            const box = d.querySelector('#account-ask-buttons');
            box.textContent = '';

            let done = false;
            const finish = (value) => {
                if (done) return;
                done = true;
                observer.disconnect();
                d.classList.remove('show');
                resolve(value);
            };
            // Escape (handled by the app) or the × button hide the dialog: treat as dismissed
            const observer = new MutationObserver(() => { if (!d.classList.contains('show')) finish(null); });
            observer.observe(d, { attributes: true, attributeFilter: ['class'] });
            d.querySelector('#account-ask-close').onclick = () => finish(null);

            buttons.forEach((label, i) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = i === 0 ? 'btn' : 'btn btn-secondary';
                b.textContent = label;
                b.onclick = () => finish(i);
                box.appendChild(b);
            });
            d.classList.add('show');
        });
    }
}
