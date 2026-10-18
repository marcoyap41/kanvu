// Starts the app. When config.js has an apiUrl the app requires an account:
//  - signed in  -> account mode (boards live on the server)
//  - signed out -> a temporary draft in this tab's sessionStorage: you can build boards and cards but not save
// With no apiUrl the app keeps boards in localStorage, as before (no sign-in).
const auth = new AuthClient({ apiUrl: KANVU_CONFIG.apiUrl });
const makeDraft = () => new LocalStorageAdapter(sessionStorage, { draft: true });

// Full-screen message while the session is restored, or when the server can't be reached
function showStartup(message, canRetry) {
    let el = document.getElementById('startup-overlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'startup-overlay';
        el.className = 'startup-overlay';
        document.body.appendChild(el);
    }
    el.textContent = '';
    const p = document.createElement('p');
    p.textContent = message;
    el.appendChild(p);
    if (canRetry) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.textContent = 'Try again';
        b.onclick = () => location.reload();
        el.appendChild(b);
    }
    el.hidden = false;
}

function hideStartup() {
    const el = document.getElementById('startup-overlay');
    if (el) el.hidden = true;
}

// Purge any deprecated localStorage data from older versions
try {
    const legacyKeys = [
        'kanban-theme', 'kanban-density', 'kanban-view', 'kanban-column-layout',
        'kanban-header-blur', 'kanban-glass-lanes', 'kanban-glass-cards',
        'kanban-glass-opacity', 'kanban-glass-blur', 'kanban-header-blur-amount',
        'kanban-stage-blur-amount', 'kanban-autosave', 'kanban-saved-boards',
        'kanban-saved-boards-backup', 'kanban-board-order', 'kanban-trash-boards',
        'kanban-current-board-id', 'kanban-board', 'kanban-columns', 'kanban-last-save',
        'kanban-account-current-board-id'
    ];
    legacyKeys.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
} catch (_) {}

const kanban = new Kanvu({
    pickStorage: async () => {
        if (!auth.enabled) return makeDraft();
        if (auth.hasSessionHint()) showStartup('Loading your boards...');
        try {
            const user = await auth.restoreSession();
            if (user) return new ApiAdapter(auth);
        } catch (e) {
            showStartup('Cannot reach the server. Your boards are safe. Try again in a moment.', true);
            return new Promise(() => {}); // stay on this screen: never show an empty board that looks like lost data
        }
        return makeDraft();
    },
    requestSignIn: (note) => account.openModal('login', note)
});

const account = new AccountUI(kanban, auth, makeDraft);
kanban.ready.then(() => {
    hideStartup();
    account.start();
});
