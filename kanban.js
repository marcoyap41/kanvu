class Kanvu {
    // options.pickStorage: optional async function that returns the storage adapter to start with
    // (the app uses it to start in account mode when a login session exists). Default: guest mode.
    // options.requestSignIn(note): called when a signed-out user tries to save (the app opens the sign-in dialog).
    constructor(options = {}) {
        this.options = options;
        this.tasks = [];
        this.columns = [];
        this.currentTaskId = null;
        this.currentColumn = 'todo';
        this.drag = null;
        this.searchTerm = '';
        this.currentDensity = 'comfortable';
        this.currentBoardId = null; // Track current board ID
        this.currentBoardName = 'My Projects';
        this.savedBoards = {};
        this.currentColumnLayout = 4;
        this.currentView = 'columns';

        // Where boards live. Guest mode = temporary draft in sessionStorage. Account mode swaps in ApiAdapter
        // with the same methods (see setStorage). No data is stored in localStorage.
        this.storage = new LocalStorageAdapter(sessionStorage, { draft: true });
        this.boardOrder = []; // in-memory copy of the stored board order
        this.trash = {};      // in-memory copy of the stored trash

        this.ready = this.init().catch(err => console.error('Kanvu failed to start:', err)); // resolves when the first render is done
    }

    async init() {
        // Load theme preference
        const savedTheme = prefs.get('theme') || 'black';
        this.currentTheme = savedTheme;
        this.changeTheme(savedTheme);
        this.updateThemeButton();

        // Load density preference
        const savedDensity = prefs.get('density') || 'comfortable';
        this.currentDensity = savedDensity;
        this.changeDensity(savedDensity);
        this.updateDensityButton();

        // Load board layout mode (vertical columns or horizontal lanes)
        this.changeView(prefs.get('view') === 'lanes' ? 'lanes' : 'columns', false);

        // Load column layout preference
        const savedLayout = parseInt(prefs.get('column-layout')) || 4;
        this.currentColumnLayout = savedLayout;
        this.changeColumnLayout(savedLayout);
        this.updateLayoutButton();

        // Wallpaper + header bar style
        this.initAppearance();

        // Decide where the data lives (guest or account), then load boards, order, trash and the open board
        if (this.options.pickStorage) this.storage = await this.options.pickStorage();
        await this.loadData();

        // In account mode: fetch server settings and apply them
        if (this.storage.mode === 'account' && this.storage.auth) {
            try {
                prefs.setAuth(this.storage.auth);
                const serverSettings = await prefs.loadFromServer();
                prefs.pause();
                try { this._applySettings(serverSettings); } finally { prefs.resume(); }
                await this.loadWallpaper(); // reload wallpaper from server now that we're in account mode
            } catch (e) { /* not critical — defaults remain in effect */ }
        }

        this.initializeBoardName();
        
        // Initialize event listeners
        this.initializeEventListeners();
        
        // Autosave toggle (off by default) and save-state watcher
        this.autosaveEnabled = prefs.get('autosave') === 'true';
        this.updateAutosaveButton();
        this.updateSaveButton();
        setInterval(() => this.watchSaveState(), 1000);
        window.addEventListener('beforeunload', (e) => {
            if (this._allowUnload) return; // set right before a planned redirect (Google/GitHub sign-in)
            // A signed-out draft is lost when the tab closes, so warn whenever it has content
            if (this.isDraft() ? !this.draftHasContent() : this.isSaved()) return;
            e.preventDefault();
            e.returnValue = '';
        });
        
        // Initialize search
        this.initializeSearch();
        
        // Initial render
        this.renderBoard();
    }

    initializeEventListeners() {
        // Range input displays with smooth updates
        document.getElementById('task-difficulty').addEventListener('input', (e) => {
            const value = e.target.value;
            const display = e.target.nextElementSibling;
            display.textContent = `${value} / 5`;
        });

        document.getElementById('task-progress').addEventListener('input', (e) => {
            const value = e.target.value;
            const display = e.target.nextElementSibling;
            display.textContent = `${value}%`;
        });

        // Remember what was clicked last, so edit panels can open right next to it
        document.addEventListener('click', (e) => {
            this._clickEl = e.target;
            this._clickAt = Date.now();
        }, true);
        window.addEventListener('resize', () => {
            document.querySelectorAll('.modal.anchored.show').forEach(m => this.positionAnchored(m));
        });

        // Drag and drop (mouse, pen and touch share one pointer-based implementation)
        this.initializeDragAndDrop();

        // Keep several open tabs in step with each other
        this.initializeCrossTabSync();

        // Close modals on escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeAllModals();
            }
        });

        // Close modals on backdrop click
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeAllModals();
                }
            });
        });

        // Close column menus when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.column-menu-container')) {
                document.querySelectorAll('.column-menu.show').forEach(menu => {
                    menu.classList.remove('show');
                });
            }
        });
    }

    initializeSearch() {
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.searchTerm = e.target.value.toLowerCase();
                this.filterTasks();
            });
        }
    }

    filterTasks() {
        const taskCards = document.querySelectorAll('.task-card');
        taskCards.forEach(card => {
            const title = card.querySelector('.task-title').textContent.toLowerCase();
            const description = card.querySelector('.task-description')?.textContent.toLowerCase() || '';
            const tags = Array.from(card.querySelectorAll('.tag')).map(tag => tag.textContent.toLowerCase()).join(' ');
            
            const matches = title.includes(this.searchTerm) || 
                          description.includes(this.searchTerm) || 
                          tags.includes(this.searchTerm);
            
            card.style.display = matches ? '' : 'none';
        });
    }

    // Theme Management
    changeTheme(theme) {
        document.body.setAttribute('data-theme', theme);
        prefs.set('theme', theme);
        this.currentTheme = theme;
    }

    setTheme(theme) {
        this.changeTheme(theme);
        this.updateThemeButton();
    }

    updateThemeButton() {
        document.querySelectorAll('[data-theme-opt]').forEach(btn => {
            btn.setAttribute('aria-pressed', btn.dataset.themeOpt === this.currentTheme ? 'true' : 'false');
        });
    }

    // Density Management
    changeDensity(density) {
        document.body.setAttribute('data-density', density);
        prefs.set('density', density);
        this.currentDensity = density;
    }

    setDensity(density) {
        this.changeDensity(density);
        this.updateDensityButton();
    }

    updateDensityButton() {
        const hints = {
            comfortable: 'Full cards: notes, difficulty, progress',
            compact: 'Smaller cards with shorter notes',
            dense: 'Titles only, most cards on screen'
        };
        document.querySelectorAll('[data-density-opt]').forEach(btn => {
            btn.setAttribute('aria-pressed', btn.dataset.densityOpt === this.currentDensity ? 'true' : 'false');
        });
        const hint = document.getElementById('density-hint');
        if (hint) hint.textContent = hints[this.currentDensity] || '';
    }

    // Board Layout Mode
    changeView(view, rerender = true) {
        this.currentView = view;
        document.body.setAttribute('data-view', view);
        prefs.set('view', view);
        document.querySelectorAll('[data-view-btn]').forEach(btn => {
            btn.setAttribute('aria-pressed', btn.dataset.viewBtn === view ? 'true' : 'false');
        });
        this.updateLayoutButton();
        if (rerender) this.renderBoard();
    }

    // Column Layout Management
    changeColumnLayout(layout) {
        document.body.setAttribute('data-columns', layout);
        prefs.set('column-layout', layout);
        this.currentColumnLayout = layout;
    }

    setColumnLayout(layout) {
        this.changeColumnLayout(Number(layout));
        this.updateLayoutButton();
    }

    updateLayoutButton() {
        const cols = this.currentView === 'columns';
        const names = cols ? { 3: '3', 4: '4', 5: '5' } : { 3: 'Wide', 4: 'Medium', 5: 'Narrow' };
        const label = document.getElementById('layout-label');
        if (label) label.textContent = cols ? 'Columns per row' : 'Card width';
        document.querySelectorAll('[data-cols-opt]').forEach(btn => {
            const n = Number(btn.dataset.colsOpt);
            btn.textContent = names[n];
            btn.title = cols ? `${n} columns per row` : `${names[n]} cards`;
            btn.setAttribute('aria-pressed', n === Number(this.currentColumnLayout) ? 'true' : 'false');
        });
    }

    // Appearance: header blur + custom wallpaper
    initAppearance() {
        this.setHeaderBlur(prefs.get('header-blur') === 'true');
        this.glass = { lanes: prefs.get('glass-lanes') === 'true', cards: prefs.get('glass-cards') === 'true' };
        const savedOpacity = parseInt(prefs.get('glass-opacity'));
        this.setGlass('lanes', this.glass.lanes);
        this.setGlass('cards', this.glass.cards);
        this.setGlassOpacity(isNaN(savedOpacity) ? 55 : savedOpacity);
        const oldBlur = parseInt(prefs.get('glass-blur')); // earlier single slider
        const hb = parseInt(prefs.get('header-blur-amount'));
        const sb = parseInt(prefs.get('stage-blur-amount'));
        this.setGlassBlur('header', !isNaN(hb) ? hb : (!isNaN(oldBlur) ? oldBlur : 16));
        this.setGlassBlur('stage', !isNaN(sb) ? sb : (!isNaN(oldBlur) ? oldBlur : 10));
        this.wallpaperBlob = null;
        this.wallpaperUrl = null;
        this.wp = null;
        this.updateWallpaperButton();
        this.initWallpaperModal();
        this.loadWallpaper();
    }

    /**
     * Applies server-loaded settings (server-key-named object) by calling the existing setters.
     * Caller must wrap with prefs.pause() / prefs.resume() so the setters don't re-PATCH the server.
     */
    _applySettings(s) {
        if (!s) return;
        if (s.theme) this.changeTheme(s.theme);
        if (s.density) this.changeDensity(s.density);
        if (s.layout) this.changeView(s.layout, false);
        if (s.columnLayout) { this.changeColumnLayout(s.columnLayout); this.updateLayoutButton(); }
        if (s.headerBlur != null) this.setHeaderBlur(s.headerBlur);
        if (s.glassLanes != null) this.setGlass('lanes', s.glassLanes);
        if (s.glassCards != null) this.setGlass('cards', s.glassCards);
        if (s.glassOpacity != null) this.setGlassOpacity(s.glassOpacity);
        if (s.headerBlurAmount != null) this.setGlassBlur('header', s.headerBlurAmount);
        if (s.stageBlurAmount != null) this.setGlassBlur('stage', s.stageBlurAmount);
        if (s.autosave != null) {
            this.autosaveEnabled = !!s.autosave;
            // Use prefs.set directly (still paused, so no extra PATCH) to sync the cache
            prefs.set('autosave', this.autosaveEnabled);
            this.updateAutosaveButton();
        }
    }

    /**
     * Resets appearance, display options, and wallpaper to default values.
     * Called on sign-out to ensure no private account state is left in the UI.
     */
    resetToDefaultSettings() {
        this.changeTheme('black');
        this.changeDensity('comfortable');
        this.changeView('columns', false);
        this.changeColumnLayout(4);
        this.updateLayoutButton();
        this.setHeaderBlur(false);
        this.setGlass('lanes', false);
        this.setGlass('cards', false);
        this.setGlassOpacity(55);
        this.setGlassBlur('header', 16);
        this.setGlassBlur('stage', 10);
        this.autosaveEnabled = false;
        this.updateAutosaveButton();
        this.showWallpaper(null);
    }

    setHeaderBlur(on, commit = !this.wp) {
        this.headerBlur = !!on;
        document.body.setAttribute('data-header', this.headerBlur ? 'blur' : 'solid');
        if (commit) prefs.set('header-blur', this.headerBlur);
        const box = document.getElementById('header-blur-toggle');
        if (box) box.checked = this.headerBlur;
        this.updateGlassControls();
        this.updateWallpaperButton();
        this.wpUpdateApplyButton();
    }

    // Translucent stages / cards (opacity is shared, lower = more wallpaper visible)
    setGlass(kind, on, commit = !this.wp) {
        this.glass[kind] = !!on;
        document.body.setAttribute(`data-glass-${kind}`, this.glass[kind] ? 'on' : 'off');
        if (commit) prefs.set(`glass-${kind}`, this.glass[kind]);
        const box = document.getElementById(`glass-${kind}-toggle`);
        if (box) box.checked = this.glass[kind];
        this.updateGlassControls();
        this.wpUpdateApplyButton();
    }

    // Opacity applies to stages/cards; blur has its own slider for the header bar and for stages
    updateGlassControls() {
        const g = this.glass || {};
        const set = (id, rowId, on) => {
            const el = document.getElementById(id), row = document.getElementById(rowId);
            if (el) el.disabled = !on;
            if (row) row.style.opacity = on ? '' : '.5';
        };
        set('glass-opacity', 'glass-opacity-row', !!(g.lanes || g.cards));
        set('header-blur-amount', 'header-blur-row', !!this.headerBlur);
        set('stage-blur-amount', 'stage-blur-row', !!g.lanes);
    }

    setGlassBlur(kind, value, commit = !this.wp) {
        const def = kind === 'header' ? 16 : 10;
        const v = parseInt(value);
        const px = isNaN(v) ? def : Math.min(30, Math.max(0, v));
        if (kind === 'header') this.headerBlurAmount = px;
        else this.stageBlurAmount = px;
        document.body.style.setProperty(kind === 'header' ? '--pbh' : '--pbs', px + 'px');
        if (commit) prefs.set(`${kind}-blur-amount`, px);
        const slider = document.getElementById(`${kind}-blur-amount`);
        if (slider) slider.value = px;
        const out = document.getElementById(`${kind}-blur-val`);
        if (out) out.textContent = px + 'px';
        this.wpUpdateApplyButton();
    }

    setGlassOpacity(value, commit = !this.wp) {
        const v = Math.min(95, Math.max(20, parseInt(value) || 55));
        this.glassOpacity = v;
        document.body.style.setProperty('--pa', v + '%');
        if (commit) prefs.set('glass-opacity', v);
        const slider = document.getElementById('glass-opacity');
        if (slider) slider.value = v;
        const out = document.getElementById('glass-opacity-val');
        if (out) out.textContent = v + '%';
        this.wpUpdateApplyButton();
    }

    async loadWallpaper() {
        if (this.storage && this.storage.mode === 'account') {
            // Account mode: fetch wallpaper from the server
            try {
                const blob = await this.storage.getWallpaper();
                this.showWallpaper(blob || null);
            } catch (e) {
                this.showWallpaper(null);
            }
        } else {
            // Draft mode: no stored server wallpaper
            this.showWallpaper(null);
        }
    }

    showWallpaper(blob) {
        if (this.wallpaperUrl) URL.revokeObjectURL(this.wallpaperUrl);
        this.wallpaperUrl = blob ? URL.createObjectURL(blob) : null;
        this.wallpaperBlob = blob;
        document.getElementById('wallpaper').style.backgroundImage = blob ? `url("${this.wallpaperUrl}")` : '';
        this.updateWallpaperButton();
    }

    updateWallpaperButton() {
        const btn = document.getElementById('wallpaper-button');
        if (!btn) return;
        btn.querySelector('.v').textContent = this.wallpaperBlob ? 'Custom' : 'Default';
        btn.title = 'Wallpaper, header bar and translucency settings';
    }

    initWallpaperModal() {
        const frame = document.getElementById('wp-frame');
        const modal = document.getElementById('wallpaper-modal');
        let drag = null;

        frame.addEventListener('pointerdown', (e) => {
            if (!this.wp || !this.wp.editable) return;
            drag = { x: e.clientX, y: e.clientY, moved: false };
            frame.setPointerCapture(e.pointerId);
            frame.classList.add('dragging');
        });
        frame.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
            drag.x = e.clientX; drag.y = e.clientY;
            this.wp.ox += dx; this.wp.oy += dy;
            this.wpRender();
        });
        const end = () => {
            if (!drag) return;
            // A drag that ends over the dimmed backdrop must not count as a backdrop click
            if (drag.moved) { this._wpSuppressClick = true; setTimeout(() => { this._wpSuppressClick = false; }, 60); }
            drag = null;
            frame.classList.remove('dragging');
        };
        frame.addEventListener('pointerup', end);
        frame.addEventListener('pointercancel', end);
        modal.addEventListener('click', (e) => {
            if (this._wpSuppressClick) { e.stopPropagation(); e.preventDefault(); }
        }, true);

        frame.addEventListener('wheel', (e) => {
            if (!this.wp || !this.wp.editable) return;
            e.preventDefault();
            const r = frame.getBoundingClientRect();
            this.wpSetZoom(this.wp.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
        }, { passive: false });

        document.getElementById('wp-zoom').addEventListener('input', (e) => {
            if (this.wp && this.wp.editable) this.wpSetZoom(parseFloat(e.target.value));
        });

        // Empty crop box doubles as a "choose image" button
        const pick = () => document.getElementById('wp-file').click();
        frame.addEventListener('click', () => { if (!frame.classList.contains('has-img')) pick(); });
        frame.addEventListener('keydown', (e) => {
            if (frame.classList.contains('has-img') || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            pick();
        });
    }

    wpHasAppearanceChanges() {
        const s = this._wpSavedAppearance;
        if (!s) return false;
        return (
            !!this.headerBlur !== s.headerBlur ||
            !!this.glass.lanes !== s.glassLanes ||
            !!this.glass.cards !== s.glassCards ||
            this.glassOpacity !== s.glassOpacity ||
            this.headerBlurAmount !== s.headerBlurAmount ||
            this.stageBlurAmount !== s.stageBlurAmount
        );
    }

    wpUpdateApplyButton() {
        const btn = document.getElementById('wp-apply');
        if (!btn) return;
        const hasNewImage = !!(this.wp && this.wp.editable && this.wp.img);
        btn.disabled = !(hasNewImage || this.wpHasAppearanceChanges());
    }

    // Empty crop box is clickable; Remove is only usable while an image is shown in the box
    wpSyncUi() {
        const frame = document.getElementById('wp-frame');
        const has = frame.classList.contains('has-img');
        if (has) { frame.removeAttribute('tabindex'); frame.removeAttribute('role'); frame.removeAttribute('aria-label'); }
        else { frame.setAttribute('tabindex', '0'); frame.setAttribute('role', 'button'); frame.setAttribute('aria-label', 'Choose an image'); }
        document.getElementById('wp-remove').disabled = !has;
    }

    openWallpaperModal() {
        document.body.classList.remove('rail-open');
        this.wpReset();

        // Snapshot current appearance so real-time preview changes can be reverted if closed without Apply
        this._wpSavedAppearance = {
            headerBlur: !!this.headerBlur,
            glassLanes: !!(this.glass && this.glass.lanes),
            glassCards: !!(this.glass && this.glass.cards),
            glassOpacity: this.glassOpacity ?? 55,
            headerBlurAmount: this.headerBlurAmount ?? 16,
            stageBlurAmount: this.stageBlurAmount ?? 10
        };

        // The crop frame copies the exact box the wallpaper layer occupies
        const box = document.getElementById('wallpaper').getBoundingClientRect();
        const ratio = box.width / box.height;
        this.wp = { ratio, boxW: Math.round(box.width), boxH: Math.round(box.height), editable: false, zoom: 1 };

        const frame = document.getElementById('wp-frame');
        frame.style.setProperty('--wp-ratio', ratio);
        document.getElementById('wp-hint').textContent =
            `The frame matches your board area (${this.wp.boxW} × ${this.wp.boxH} px, ${ratio.toFixed(2)}:1). Drag to move, scroll or use the slider to zoom.`;
        document.getElementById('wp-choose').textContent = this.wallpaperBlob ? 'Change image' : 'Choose image';
        document.getElementById('wp-zoom-row').classList.add('hidden');
        this.wpUpdateApplyButton();

        this.wpSyncUi();
        document.getElementById('wallpaper-modal').classList.add('show');

        if (this.wallpaperUrl) {
            const token = this.wp;
            this.wpLoadImage(this.wallpaperUrl).then((im) => {
                if (this.wp === token && !token.img) this.wpShowImage(im, false);
            }).catch(() => {});
        }
    }

    closeWallpaperModal() {
        document.getElementById('wallpaper-modal').classList.remove('show');
        this.wpReset();
        if (this._wpSavedAppearance) {
            const s = this._wpSavedAppearance;
            this._wpSavedAppearance = null;
            this.setHeaderBlur(s.headerBlur, false);
            this.setGlass('lanes', s.glassLanes, false);
            this.setGlass('cards', s.glassCards, false);
            this.setGlassOpacity(s.glassOpacity, false);
            this.setGlassBlur('header', s.headerBlurAmount, false);
            this.setGlassBlur('stage', s.stageBlurAmount, false);
        }
    }

    wpReset() {
        if (this._wpTempUrl) { URL.revokeObjectURL(this._wpTempUrl); this._wpTempUrl = null; }
        this.wp = null;
        const frame = document.getElementById('wp-frame');
        if (frame) frame.classList.remove('has-img', 'editable', 'dragging');
        const img = document.getElementById('wp-img');
        if (img) img.removeAttribute('src');
        const file = document.getElementById('wp-file');
        if (file) file.value = '';
        if (frame) this.wpSyncUi();
    }

    wpLoadImage(url) {
        return new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error('decode'));
            im.src = url;
        });
    }

    handleWallpaperFile(event) {
        const file = event.target.files && event.target.files[0];
        if (!file || !this.wp) return;
        if (!file.type.startsWith('image/')) {
            this.showToast('Please choose an image file', 'error');
            return;
        }
        const url = URL.createObjectURL(file);
        this.wpLoadImage(url).then((im) => {
            if (!this.wp) { URL.revokeObjectURL(url); return; }
            if (this._wpTempUrl) URL.revokeObjectURL(this._wpTempUrl);
            this._wpTempUrl = url;
            this.wpShowImage(im, true);
        }).catch(() => {
            URL.revokeObjectURL(url);
            this.showToast('Could not read that image', 'error');
        });
    }

    wpShowImage(im, editable) {
        const wp = this.wp;
        const frame = document.getElementById('wp-frame');
        const img = document.getElementById('wp-img');
        img.src = im.src;
        img.style.width = im.naturalWidth + 'px';
        img.style.height = im.naturalHeight + 'px';
        frame.classList.add('has-img');
        frame.classList.toggle('editable', editable);

        wp.img = im;
        wp.iw = im.naturalWidth;
        wp.ih = im.naturalHeight;
        wp.editable = editable;
        wp.fw = frame.clientWidth;
        wp.fh = frame.clientHeight;
        wp.base = Math.max(wp.fw / wp.iw, wp.fh / wp.ih); // smallest scale that still covers the frame
        wp.zoom = 1;
        wp.ox = (wp.fw - wp.iw * wp.base) / 2;
        wp.oy = (wp.fh - wp.ih * wp.base) / 2;

        document.getElementById('wp-zoom').value = 1;
        document.getElementById('wp-zoom-row').classList.toggle('hidden', !editable);
        this.wpUpdateApplyButton();
        this.wpSyncUi();
        this.wpRender();
    }

    wpRender() {
        const wp = this.wp;
        if (!wp || !wp.img) return;
        const s = wp.base * wp.zoom;
        wp.ox = Math.min(0, Math.max(wp.fw - wp.iw * s, wp.ox));
        wp.oy = Math.min(0, Math.max(wp.fh - wp.ih * s, wp.oy));
        document.getElementById('wp-img').style.transform = `translate(${wp.ox}px, ${wp.oy}px) scale(${s})`;
    }

    // Zoom keeps the point (cx, cy) of the frame fixed under the cursor/center
    wpSetZoom(z, cx = this.wp.fw / 2, cy = this.wp.fh / 2) {
        const wp = this.wp;
        const nz = Math.min(4, Math.max(1, z));
        const oldS = wp.base * wp.zoom, newS = wp.base * nz;
        const px = (cx - wp.ox) / oldS, py = (cy - wp.oy) / oldS;
        wp.ox = cx - px * newS;
        wp.oy = cy - py * newS;
        wp.zoom = nz;
        document.getElementById('wp-zoom').value = nz;
        this.wpRender();
    }

    async saveWallpaper() {
        const wp = this.wp;
        if (!wp) return;
        const hasNewImage = !!(wp.editable && wp.img);
        const hasAppearanceChanges = this.wpHasAppearanceChanges();
        if (!hasNewImage && !hasAppearanceChanges) return;

        const applyBtn = document.getElementById('wp-apply');
        if (applyBtn) { applyBtn.disabled = true; applyBtn.classList.add('btn-loading'); }
        try {
            if (hasNewImage) {
                const s = wp.base * wp.zoom;
                const sx = -wp.ox / s, sy = -wp.oy / s, sw = wp.fw / s, sh = wp.fh / s;
                const k = Math.min(1, 2560 / Math.max(sw, sh)); // never upscale, cap the longest side
                const outW = Math.max(1, Math.round(sw * k));
                const outH = Math.max(1, Math.round(outW / wp.ratio));
                const canvas = document.createElement('canvas');
                canvas.width = outW;
                canvas.height = outH;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(wp.img, sx, sy, sw, sh, 0, 0, outW, outH);
                const blob = await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('encode')), 'image/jpeg', 0.9));
                if (this.storage && this.storage.mode === 'account') {
                    // Account mode: upload to server
                    await this.storage.putWallpaper(blob);
                }
                this.showWallpaper(blob);
            }
            if (hasAppearanceChanges) {
                prefs.set('header-blur', this.headerBlur);
                prefs.set('glass-lanes', this.glass.lanes);
                prefs.set('glass-cards', this.glass.cards);
                prefs.set('glass-opacity', this.glassOpacity);
                prefs.set('header-blur-amount', this.headerBlurAmount);
                prefs.set('stage-blur-amount', this.stageBlurAmount);
                await prefs.flush();
            }
            this._wpSavedAppearance = null; // committed: do not revert in closeWallpaperModal
            this.closeWallpaperModal();
            this.showToast('Wallpaper applied', 'success');
        } catch (e) {
            this.wpUpdateApplyButton();
            this.showToast('Could not save the wallpaper', 'error');
        } finally {
            if (applyBtn) applyBtn.classList.remove('btn-loading');
        }
    }

    // A newly chosen (not yet applied) image is simply discarded; the saved wallpaper, if any, shows again
    wpDiscardPending() {
        const wp = this.wp;
        if (this._wpTempUrl) { URL.revokeObjectURL(this._wpTempUrl); this._wpTempUrl = null; }
        const file = document.getElementById('wp-file');
        if (file) file.value = '';
        const frame = document.getElementById('wp-frame');
        const img = document.getElementById('wp-img');
        frame.classList.remove('has-img', 'editable', 'dragging');
        img.removeAttribute('src');
        wp.img = null;
        wp.editable = false;
        wp.zoom = 1;
        document.getElementById('wp-zoom').value = 1;
        document.getElementById('wp-zoom-row').classList.add('hidden');
        this.wpUpdateApplyButton();
        this.wpSyncUi();
        if (this.wallpaperUrl) {
            this.wpLoadImage(this.wallpaperUrl).then((im) => {
                if (this.wp === wp && !wp.img) this.wpShowImage(im, false);
            }).catch(() => {});
        }
    }

    async removeWallpaper() {
        const wp = this.wp;
        if (!wp || !wp.img) return; // nothing selected, nothing to remove
        if (wp.editable) { this.wpDiscardPending(); return; }
        const removeBtn = document.getElementById('wp-remove');
        if (this.storage && this.storage.mode === 'account') {
            // Account mode: delete from server
            if (removeBtn) { removeBtn.disabled = true; removeBtn.classList.add('btn-loading'); }
            try {
                await this.storage.deleteWallpaper();
            } catch (e) {
                this.showToast('Could not remove the wallpaper', 'error');
                return;
            } finally {
                if (removeBtn) { removeBtn.disabled = false; removeBtn.classList.remove('btn-loading'); }
            }
        }
        this.showWallpaper(null);
        this.closeWallpaperModal();
        this.showToast('Wallpaper removed', 'info');
    }

    // Column Movement
    moveColumnLeft(columnId) {
        const sortedColumns = [...this.columns].sort((a, b) => a.order - b.order);
        const sortedIndex = sortedColumns.findIndex(c => c.id === columnId);
        
        if (sortedIndex > 0) {
            // Swap order values with the previous column in sorted order
            const currentColumn = sortedColumns[sortedIndex];
            const previousColumn = sortedColumns[sortedIndex - 1];
            
            const temp = currentColumn.order;
            currentColumn.order = previousColumn.order;
            previousColumn.order = temp;
            
            this.saveColumnsToStorage();
            this.renderBoard();
            this.showToast(`Stage moved ${this.currentView === 'columns' ? 'left' : 'up'}`, 'success');
        }
    }

    moveColumnRight(columnId) {
        const sortedColumns = [...this.columns].sort((a, b) => a.order - b.order);
        const sortedIndex = sortedColumns.findIndex(c => c.id === columnId);
        
        if (sortedIndex < sortedColumns.length - 1) {
            // Swap order values with the next column in sorted order
            const currentColumn = sortedColumns[sortedIndex];
            const nextColumn = sortedColumns[sortedIndex + 1];
            
            const temp = currentColumn.order;
            currentColumn.order = nextColumn.order;
            nextColumn.order = temp;
            
            this.saveColumnsToStorage();
            this.renderBoard();
            this.showToast(`Stage moved ${this.currentView === 'columns' ? 'right' : 'down'}`, 'success');
        }
    }

    toggleColumnMenu(columnId) {
        const menu = document.getElementById(`menu-${columnId}`);
        const isVisible = menu.classList.contains('show');
        
        // Close all open menus first
        this.closeColumnMenus();
        
        // Toggle the clicked menu
        if (!isVisible) {
            menu.classList.add('show');
        }
    }

    closeColumnMenus() {
        document.querySelectorAll('.column-menu.show').forEach(menu => {
            menu.classList.remove('show');
        });
    }

    // Board Management
    initializeBoardName() {
        const boardNameInput = document.getElementById('board-name');
        if (boardNameInput) {
            boardNameInput.value = this.currentBoardName;
            
            // Update name in memory as user types, but don't save yet
            boardNameInput.addEventListener('input', (e) => {
                this.currentBoardName = e.target.value || 'My Board';
            });

            // Commit when user finishes editing (loses focus)
            boardNameInput.addEventListener('blur', () => {
                this.commit();
            });

            // Also save on Enter key
            boardNameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    boardNameInput.blur(); // This will trigger the blur event and save
                }
            });
        }
    }

    // Loads boards, order and trash from the storage adapter into memory.
    // Reads after this stay synchronous because they use these in-memory copies.
    async loadSavedBoards() {
        const data = await this.storage.loadAll();
        this.savedBoards = data.boards || {};
        this.boardOrder = data.order || [];
        this.trash = data.trash || {};

        // Ensure we always have at least a default board
        if (Object.keys(this.savedBoards).length === 0) {
            const defaultBoardId = this.generateBoardId('Untitled Board');
            const now = new Date().toISOString();
            this.savedBoards[defaultBoardId] = {
                id: defaultBoardId,
                name: 'Untitled Board',
                tasks: [],
                columns: [
                    { id: 'backlog', title: 'Backlog', order: 0, color: '#a855f7' },
                    { id: 'todo', title: 'To Do', order: 1, color: '#ef4444' },
                    { id: 'in-progress', title: 'In Progress', order: 2, color: '#eab308' },
                    { id: 'done', title: 'Done', order: 3, color: '#22c55e' }
                ],
                lastModified: now,
                createdAt: now
            };
            await this.saveBoardsToStorage([defaultBoardId]);
        }
    }

    // Everything that depends on where the data lives: boards, order, trash and the open board
    async loadData() {
        await this.loadSavedBoards();
        this.loadCurrentBoard();
    }

    // Switch storage (guest: LocalStorageAdapter, account: ApiAdapter), reload everything from it and redraw.
    // Save or discard the open board's unsaved changes BEFORE calling this.
    async setStorage(adapter) {
        try { await this._saveQueue; } catch (e) { /* a failed save was already reported */ } // let saves to the old storage finish first
        if (this._unsubscribeSync) { this._unsubscribeSync(); this._unsubscribeSync = null; }
        this.storage = adapter;
        this.currentBoardId = null;
        await this.loadData();
        this.initializeCrossTabSync();
        this.updateModeUI();
        this.updateBoardNameInput();
        this.renderBoard();
        this.refreshBoardManager();
        // Reload wallpaper whenever we switch into account mode (sign-in after app is running)
        if (this.storage.mode === 'account') {
            try { await this.loadWallpaper(); } catch (e) { /* not critical */ }
        }
    }

        // ---- Signed-out draft ----
    // Draft = the app requires an account and nobody is signed in: boards live only in this tab's sessionStorage
    isDraft() {
        return !!this.storage && this.storage.mode === 'draft';
    }

    requestSignIn(note) {
        if (this.options.requestSignIn) this.options.requestSignIn(note);
    }

    // Call right before a planned page redirect so the "unsaved draft" warning does not appear
    allowUnload() {
        this._allowUnload = true;
    }

    // A fresh draft is one empty "Untitled Board"; that is not worth warning about
    draftHasContent() {
        return Object.keys(this.savedBoards).length > 1 || this.tasks.length > 0 || this.currentBoardName !== 'Untitled Board';
    }

    // Save button and autosave switch follow the mode (draft or account)
    updateModeUI() {
        this.updateSaveButton();
        this.updateAutosaveButton();
    }

    // Puts the open board's name into the title input (never overwrites what is being typed)
    updateBoardNameInput() {
        const input = document.getElementById('board-name');
        if (input && document.activeElement !== input) input.value = this.currentBoardName;
    }

    generateBoardId(name) {
        // The storage decides the id format (account mode uses UUIDs the server can store as-is)
        if (this.storage && typeof this.storage.newBoardId === 'function') return this.storage.newBoardId(name);
        // Guest mode: unique ID based on name and timestamp
        return `board_${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}_${Date.now()}`;
    }
    
    loadCurrentBoard() {
        // Get the current board ID or use the first available board
        this.currentBoardId = this.storage.getCurrentBoardId();
        
        if (!this.currentBoardId || !this.savedBoards[this.currentBoardId]) {
            // Use the first board if invalid board
            this.currentBoardId = Object.keys(this.savedBoards)[0];
            this.storage.setCurrentBoardId(this.currentBoardId);
        }
        
        const board = this.savedBoards[this.currentBoardId];
        if (board) {
            this.currentBoardName = board.name;
            this.tasks = board.tasks || [];
            this.columns = board.columns || [
                { id: 'backlog', title: 'Backlog', order: 0, color: '#a855f7' },
                { id: 'todo', title: 'To Do', order: 1, color: '#ef4444' },
                { id: 'in-progress', title: 'In Progress', order: 2, color: '#eab308' },
                { id: 'done', title: 'Done', order: 3, color: '#22c55e' }
            ];
            this.markSaved(board.lastModified);
        }
    }

    // Writes boards through the storage adapter, then refreshes the in-memory copy from what it returns.
    //   changed = ids of boards this tab created or edited
    //   removed = ids of boards this tab deleted on purpose
    // Resolves to true on success, false (with an error toast) on failure.
    async saveBoardsToStorage(changed = [], removed = []) {
        const toSave = {};
        changed.forEach(id => { if (this.savedBoards[id]) toSave[id] = this.savedBoards[id]; });
        try {
            const latest = await this.storage.saveBoards(toSave, removed);
            if (latest) this.savedBoards = latest;
        } catch (e) {
            console.error('Failed to save boards:', e);
            this.showToast(`Could not save: ${e.message}`, 'error');
            return false;
        }
        setTimeout(() => this.renderRail(), 0);
        return true;
    }

    // What the current board looks like right now, used to tell whether anything changed
    boardSignature() {
        return JSON.stringify([this.currentBoardName, this.tasks, this.columns]);
    }

    // True when the open board is identical to what is stored
    isSaved() {
        return this.boardSignature() === this._savedSig;
    }

    // Remember the state that is known to be on disk
    markSaved(stamp, sig) {
        // sig = the state that was actually written (edits made while a save was in flight stay unsaved)
        this._savedSig = sig !== undefined ? sig : this.boardSignature();
        this.boardStamp = stamp || null;
        this.updateSaveButton();
    }

    // Called after every edit: persists only when autosave is on.
    // With autosave off the board stays unsaved until the Save button (or a board switch) saves it.
    commit() {
        if (this.isDraft() || this.autosaveEnabled) this.saveCurrentBoard(); // a draft is kept in this tab's session silently
        else this.updateSaveButton();
    }

    // Save button shows "Saved ✔" (disabled) when there is nothing to save
    updateSaveButton() {
        const button = document.getElementById('save-button');
        if (!button) return;
        if (this.isDraft()) { // signed out: hide the save button — the account button is the sole sign-in CTA
            button.hidden = true;
            return;
        }
        button.hidden = false;
        if (this._isSaving) {
            button.disabled = true;
            button.textContent = 'Saving...';
            return;
        }
        const saved = this.isSaved();
        button.disabled = saved;
        button.textContent = saved ? 'Saved ✔' : 'Save';
    }

    // Runs every second: keeps the Save button honest and, if enabled, autosaves
    // once the board has been dirty and untouched for a couple of seconds
    watchSaveState() {
        if (this.drag) return;
        const sig = this.boardSignature();
        if (sig !== this._watchSig) {
            this._watchSig = sig;
            this._stableTicks = 0;
        } else {
            this._stableTicks = (this._stableTicks || 0) + 1;
        }
        this.updateSaveButton();
        if ((this.isDraft() || this.autosaveEnabled) && sig !== this._savedSig && this._stableTicks >= 2 && !this._pendingSaves) {
            this.saveCurrentBoard();
        }
    }

    toggleAutosave() {
        if (this.isDraft()) { this.requestSignIn('Sign in to save your boards and use autosave.'); return; }
        if (this.autosaveEnabled) {
            this.showConfirmDialog('Disable autosave', 'Changes will no longer be saved automatically.\n\nYou will need to click Save, or you may lose them when leaving the page.', (confirmed) => {
                if (confirmed) this.setAutosave(false);
            });
        } else {
            this.setAutosave(true);
        }
    }

    setAutosave(enabled) {
        this.autosaveEnabled = enabled;
        prefs.set('autosave', this.autosaveEnabled);
        this.updateAutosaveButton();
        this.showToast(`Autosave ${this.autosaveEnabled ? 'enabled' : 'disabled'}`, 'info');
    }

    updateAutosaveButton() {
        const button = document.getElementById('autosave-button');
        if (!button) return;
        const hint = document.getElementById('autosave-hint');
        if (this.isDraft()) { // signed out: autosave is unavailable
            button.disabled = true;
            button.setAttribute('aria-checked', 'false');
            button.title = 'Sign in to use autosave';
            if (hint) hint.textContent = 'Sign in to use autosave';
            return;
        }
        button.disabled = false;
        button.setAttribute('aria-checked', this.autosaveEnabled ? 'true' : 'false');
        button.title = this.autosaveEnabled ? 'Autosave is on. Click to turn off' : 'Autosave is off. Click to turn on';
        if (hint) hint.textContent = this.autosaveEnabled ? 'Saves changes for you' : 'Off: use the Save button';
    }

    // The storage tells us when its data changed somewhere else (another tab, later another device)
    initializeCrossTabSync() {
        if (this._unsubscribeSync) this._unsubscribeSync();
        this._unsubscribeSync = typeof this.storage.onExternalChange === 'function'
            ? this.storage.onExternalChange(() => {
                clearTimeout(this._syncTimer);
                this._syncTimer = setTimeout(() => this.syncFromStorage(), 150);
            })
            : null;
    }

    async syncFromStorage() {
        if (this.drag) { // never re-render in the middle of a drag
            this._syncTimer = setTimeout(() => this.syncFromStorage(), 400);
            return;
        }
        let data;
        try {
            data = await this.storage.loadAll();
        } catch (e) {
            console.error('Sync failed:', e);
            return;
        }
        this.boardOrder = data.order || [];
        this.trash = data.trash || {};
        const stored = data.boards;
        if (!stored || Object.keys(stored).length === 0) {
            this.renderRail();
            this.refreshBoardManager();
            return;
        }

        const mine = this.savedBoards[this.currentBoardId];
        const theirs = stored[this.currentBoardId];
        let adopted = false;

        if (!theirs) {
            // The board open here was removed elsewhere. Keep our copy rather than lose it;
            // clearing the signature marks it unsaved so it can be written back.
            if (mine) stored[this.currentBoardId] = mine;
            this._savedSig = null;
            this.updateSaveButton();
        } else if (new Date(theirs.lastModified) > new Date(this.boardStamp || 0)) {
            // Another tab saved a newer version of the board that is open here
            this.currentBoardName = theirs.name;
            this.tasks = theirs.tasks || [];
            this.columns = theirs.columns || this.columns;
            this.markSaved(theirs.lastModified);
            this.updateBoardNameInput();
            adopted = true;
        } else if (mine) {
            stored[this.currentBoardId] = mine; // ours is up to date, keep the live object
        }

        this.savedBoards = stored;
        if (adopted) {
            this.renderBoard();
            this.showToast('Board updated from another tab', 'info');
        } else {
            this.renderRail();
        }
        this.refreshBoardManager();
    }

    // Saves run one after another, so two never overlap (a slow network save can't be overtaken by a newer one).
    // Resolves to true when the board was saved.
    saveCurrentBoard() {
        this._pendingSaves = (this._pendingSaves || 0) + 1;
        const run = () => this.saveCurrentBoardNow().finally(() => { this._pendingSaves--; });
        this._saveQueue = (this._saveQueue || Promise.resolve()).then(run, run);
        return this._saveQueue;
    }

    async saveCurrentBoardNow() {
        if (!this.currentBoardId) {
            // Create a new board ID if we don't have one
            this.currentBoardId = this.generateBoardId(this.currentBoardName);
            this.storage.setCurrentBoardId(this.currentBoardId);
        }

        // Check if name changed and we need a new ID
        const currentBoard = this.savedBoards[this.currentBoardId];
        if (currentBoard && currentBoard.name !== this.currentBoardName) {
            // Board name changed, update the board data
            currentBoard.name = this.currentBoardName;
        }

        const sig = this.boardSignature(); // what is being saved right now
        const boardData = {
            id: this.currentBoardId,
            name: this.currentBoardName,
            tasks: this.tasks,
            columns: this.columns,
            lastModified: new Date().toISOString(),
            createdAt: currentBoard?.createdAt || new Date().toISOString()
        };

        this._isSaving = true;
        this.updateSaveButton();
        try {
            this.savedBoards[this.currentBoardId] = boardData;
            const ok = await this.saveBoardsToStorage([this.currentBoardId]);
            if (ok) this.markSaved(boardData.lastModified, sig);
            return ok;
        } finally {
            this._isSaving = false;
            this.updateSaveButton();
        }
    }

    loadBoard(boardId, quiet = false) {
        const board = this.savedBoards[boardId];
        if (board) {
            this.currentBoardId = boardId;
            this.currentBoardName = board.name;
            this.tasks = board.tasks || [];
            this.columns = board.columns || [
                { id: 'todo', title: 'To Do', order: 0 },
                { id: 'in-progress', title: 'In Progress', order: 1 },
                { id: 'done', title: 'Done', order: 2 }
            ];

            // Remember which board is open on this device
            this.storage.setCurrentBoardId(boardId);
            this.markSaved(board.lastModified);

            // Update UI
            this.updateBoardNameInput();
            this.renderBoard();
            if (!quiet) this.showToast(`Loaded board: ${board.name}`, 'success');
        }
    }

    // ---- Board order (kept apart from the board data itself) ----
    getOrderedBoardIds() {
        const ids = Object.keys(this.savedBoards);
        const ordered = this.boardOrder.filter(id => ids.includes(id));
        ids.forEach(id => { if (!ordered.includes(id)) ordered.push(id); });
        return ordered;
    }

    async setBoardOrder(ids) {
        try {
            await this.storage.setOrder(ids);
        } catch (e) {
            this.showToast('Could not save board order', 'error');
            return;
        }
        this.boardOrder = ids;
        this.renderRail();
        this.refreshBoardManager();
    }

    moveBoard(boardId, dir) {
        const ids = this.getOrderedBoardIds();
        const i = ids.indexOf(boardId);
        const j2 = i + dir;
        if (i < 0 || j2 < 0 || j2 >= ids.length) return;
        [ids[i], ids[j2]] = [ids[j2], ids[i]];
        this.setBoardOrder(ids);
    }

    moveBoardTo(boardId, targetId, after) {
        if (boardId === targetId) return;
        const ids = this.getOrderedBoardIds().filter(id => id !== boardId);
        const t = ids.indexOf(targetId);
        if (t < 0) return;
        ids.splice(after ? t + 1 : t, 0, boardId);
        this.setBoardOrder(ids);
    }

    // ---- Trash (in-memory copy in this.trash, changes go through the storage adapter) ----
    readTrash() {
        return this.trash;
    }

    async restoreBoard(boardId) {
        if (!this.trash[boardId]) return;
        let board;
        try {
            board = await this.storage.restoreBoard(boardId);
        } catch (e) {
            this.showToast(`Could not restore: ${e.message}`, 'error');
            return;
        }
        if (!board) return;
        this.savedBoards[boardId] = board;
        delete this.trash[boardId];
        this.renderRail();
        this.refreshBoardManager();
        this.showToast(`Restored board: ${board.name}`, 'success');
    }

    deleteBoardForever(boardId) {
        const item = this.trash[boardId];
        if (!item) return;
        this.showConfirmDialog('Delete permanently', `Permanently delete "${item.name}"?\n\nThis action cannot be undone.`, async () => {
            try {
                await this.storage.purgeBoard(boardId);
            } catch (e) {
                this.showToast(`Could not update trash: ${e.message}`, 'error');
                return;
            }
            delete this.trash[boardId];
            this.refreshBoardManager();
            this.showToast(`Permanently deleted: ${item.name}`, 'info');
        });
    }

    emptyTrash() {
        const count = Object.keys(this.trash).length;
        if (!count) return;
        this.showConfirmDialog('Empty trash', `Permanently delete ${count} board${count === 1 ? '' : 's'} in the trash?\n\nThis action cannot be undone.`, async () => {
            try {
                await this.storage.emptyTrash();
            } catch (e) {
                this.showToast(`Could not update trash: ${e.message}`, 'error');
                return;
            }
            this.trash = {};
            this.refreshBoardManager();
            this.showToast('Trash emptied', 'info');
        });
    }

    // ---- Panels that open next to what was clicked ----
    // Edit panels used to slide in from the far edge of the screen, which is a long way from
    // the sidebar button or the card being edited. They now sit beside the thing that opened them.
    recentClickEl() {
        const el = this._clickEl;
        return el && el.isConnected && Date.now() - (this._clickAt || 0) < 1000 ? el : null;
    }

    showAnchoredModal(modal, anchor, opts = {}) {
        modal._anchor = anchor || null;
        modal._anchorOpts = opts;
        modal.classList.add('show');
        this.positionAnchored(modal);
    }

    positionAnchored(modal) {
        if (!modal || !modal.classList.contains('show')) return;
        const box = modal.querySelector('.modal-content');
        if (!box) return;
        const anchor = modal._anchor && modal._anchor.isConnected ? modal._anchor : null;
        const opts = modal._anchorOpts || {};
        const vw = document.documentElement.clientWidth, vh = window.innerHeight;
        const margin = 12, gap = 10;
        const w = box.offsetWidth, h = box.offsetHeight;
        let left = (vw - w) / 2, top = (vh - h) / 2; // no anchor: centered
        if (anchor) {
            const r = anchor.getBoundingClientRect();
            const ref = opts.alignTo && opts.alignTo.isConnected ? opts.alignTo.getBoundingClientRect() : r;
            if (r.right + gap + w <= vw - margin) left = r.right + gap;        // beside it, to the right
            else if (r.left - gap - w >= margin) left = r.left - gap - w;      // otherwise to the left
            else left = r.left + r.width / 2 - w / 2;                          // otherwise over it
            top = ref.top;
        }
        box.style.left = Math.max(margin, Math.min(left, vw - w - margin)) + 'px';
        box.style.top = Math.max(margin, Math.min(top, vh - h - margin)) + 'px';
    }

    defaultColumns() {
        return [
            { id: 'backlog', title: 'Backlog', order: 0, color: '#a855f7' },
            { id: 'todo', title: 'To Do', order: 1, color: '#ef4444' },
            { id: 'in-progress', title: 'In Progress', order: 2, color: '#eab308' },
            { id: 'done', title: 'Done', order: 3, color: '#22c55e' }
        ];
    }

    // ---- Board manager ----
    openBoardManager() {
        let modal = document.getElementById('board-manager-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'board-manager-modal';
            modal.className = 'modal anchored';
            modal.innerHTML = `
                <div class="modal-content modal-compact">
                    <div class="modal-header">
                        <h2 class="modal-title">Manage boards</h2>
                        <button class="modal-close" onclick="kanban.closeBoardManager()">×</button>
                    </div>
                    <div class="board-manager-compact">
                        <div class="board-actions-row">
                            <button class="btn btn-sm" onclick="kanban.createNewBoard()">New board</button>
                            <button class="btn btn-sm btn-secondary" onclick="kanban.duplicateCurrentBoard()">Duplicate board</button>
                        </div>
                        <div class="boards-list-compact" id="saved-boards-list-compact"></div>
                        <div id="board-trash"></div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            this.initBoardDrag(modal);
        }
        this.refreshBoardManager();
        // Open beside the sidebar, level with the Manage button that was pressed
        this.showAnchoredModal(modal, document.getElementById('rail'), { alignTo: document.querySelector('.rail-head .link') });
    }

    refreshBoardManager() {
        const modal = document.getElementById('board-manager-modal');
        if (!modal) return;
        modal.querySelector('#saved-boards-list-compact').innerHTML = this.renderCompactBoardsList();
        modal.querySelector('#board-trash').innerHTML = this.renderTrashSection();
        this.positionAnchored(modal); // the list may have grown or shrunk
    }

    // Drag a board row to reorder (buttons do the same for touch / keyboard)
    initBoardDrag(modal) {
        const rowOf = e => e.target.closest && e.target.closest('[data-board-id]');
        const clear = () => modal.querySelectorAll('.drop-before,.drop-after,.dragging')
            .forEach(el => el.classList.remove('drop-before', 'drop-after', 'dragging'));
        const isAfter = (e, row) => {
            const r = row.getBoundingClientRect();
            return e.clientY > r.top + r.height / 2;
        };
        modal.addEventListener('dragstart', e => {
            const row = rowOf(e);
            if (!row) return;
            this._dragBoardId = row.dataset.boardId;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', this._dragBoardId);
            row.classList.add('dragging');
        });
        modal.addEventListener('dragover', e => {
            const row = rowOf(e);
            if (!row || !this._dragBoardId) return;
            e.preventDefault();
            modal.querySelectorAll('.drop-before,.drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
            row.classList.add(isAfter(e, row) ? 'drop-after' : 'drop-before');
        });
        modal.addEventListener('drop', e => {
            const row = rowOf(e);
            if (!row || !this._dragBoardId) return;
            e.preventDefault();
            const id = this._dragBoardId;
            this._dragBoardId = null;
            clear();
            this.moveBoardTo(id, row.dataset.boardId, isAfter(e, row));
        });
        modal.addEventListener('dragend', () => {
            this._dragBoardId = null;
            clear();
        });
    }

    renderTrashSection() {
        const trash = this.readTrash();
        const ids = Object.keys(trash).sort((a, b) => new Date(trash[b].deletedAt || 0) - new Date(trash[a].deletedAt || 0));
        const rows = ids.map(id => {
            const b = trash[id];
            const n = b.tasks ? b.tasks.length : 0;
            const c = b.columns ? b.columns.length : 3;
            const when = b.deletedAt ? new Date(b.deletedAt).toLocaleDateString() : '';
            return `
                <div class="board-item-compact">
                    <div class="board-item-left">
                        <span class="board-name">${this.escapeHtml(b.name)}</span>
                    </div>
                    <div class="board-item-right">
                        <span class="board-stats">${n}T/${c}C${when ? ' · ' + when : ''}</span>
                        <button class="btn-compact" onclick="kanban.restoreBoard('${id}')" title="Restore">Restore</button>
                        <button class="btn-compact btn-danger" onclick="kanban.deleteBoardForever('${id}')" title="Delete permanently">×</button>
                    </div>
                </div>`;
        }).join('');
        return `
            <details class="trash-section" ${this._trashOpen ? 'open' : ''} ontoggle="kanban._trashOpen = this.open">
                <summary>Trash (${ids.length})</summary>
                ${ids.length ? rows + '<button class="btn-compact btn-danger trash-empty" onclick="kanban.emptyTrash()">Empty trash</button>' : '<div class="empty-state-compact">Trash is empty</div>'}
            </details>`;
    }

    renderSavedBoardsList() {
        const boardIds = Object.keys(this.savedBoards).filter(id => id !== this.currentBoardId);
        
        if (boardIds.length === 0) {
            return '<div class="empty-state">No other boards saved yet</div>';
        }

        return boardIds.map(boardId => {
            const board = this.savedBoards[boardId];
            const taskCount = board.tasks ? board.tasks.length : 0;
            const columnCount = board.columns ? board.columns.length : 3;
            const lastModified = board.lastModified ? new Date(board.lastModified).toLocaleDateString() : 'Unknown';
            
            return `
                <div class="board-item">
                    <div class="board-main">
                        <span class="board-name">${this.escapeHtml(board.name)}</span>
                        <span class="board-info">${taskCount} tasks, ${columnCount} columns</span>
                        <span class="board-date">Modified: ${lastModified}</span>
                    </div>
                    <div class="board-actions">
                        <button class="btn btn-secondary" onclick="kanban.switchToBoard('${boardId}')" title="Load Board">📂</button>
                        <button class="btn btn-secondary" onclick="kanban.deleteBoard('${boardId}')" title="Delete Board">🗑️</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    renderCompactBoardsList() {
        const ids = this.getOrderedBoardIds();
        if (ids.length === 0) {
            return '<div class="empty-state-compact">No boards saved</div>';
        }
        return ids.map((boardId, i) => {
            const cur = boardId === this.currentBoardId;
            const board = this.savedBoards[boardId];
            const name = cur ? this.currentBoardName : board.name;
            const taskCount = cur ? this.tasks.length : (board.tasks ? board.tasks.length : 0);
            const columnCount = cur ? this.columns.length : (board.columns ? board.columns.length : 3);
            return `
                <div class="board-item-compact${cur ? ' current-board' : ''}" draggable="true" data-board-id="${boardId}">
                    <div class="board-item-left">
                        <span class="drag-handle" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
                        <span class="board-name">${this.escapeHtml(name)}</span>
                        ${cur ? '<span class="board-badge">Current</span>' : ''}
                    </div>
                    <div class="board-item-right">
                        <span class="board-stats">${taskCount}T/${columnCount}C</span>
                        <button class="btn-compact btn-move" onclick="kanban.moveBoard('${boardId}', -1)" ${i === 0 ? 'disabled' : ''} title="Move up" aria-label="Move up">▲</button>
                        <button class="btn-compact btn-move" onclick="kanban.moveBoard('${boardId}', 1)" ${i === ids.length - 1 ? 'disabled' : ''} title="Move down" aria-label="Move down">▼</button>
                        ${cur
                            ? `<span class="board-save-status">${this.getCompactSaveInfo()}</span>`
                            : `<button class="btn-compact" onclick="kanban.switchToBoard('${boardId}')" title="Open">Open</button>`}
                        <button class="btn-compact btn-danger" onclick="kanban.deleteBoard('${boardId}')" ${ids.length <= 1 ? 'disabled' : ''} title="${ids.length <= 1 ? 'Cannot delete the last board' : 'Move to trash'}" aria-label="Move to trash">×</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    getCompactSaveInfo() {
        const board = this.savedBoards[this.currentBoardId];
        if (!board || !board.lastModified) return 'Not saved';
        
        const now = new Date();
        const lastSave = new Date(board.lastModified);
        const diffMs = now - lastSave;
        const diffMins = Math.floor(diffMs / 60000);
        
        if (diffMins < 1) return '✓ Saved';
        if (diffMins < 60) return `${diffMins}m ago`;
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours}h ago`;
        const diffDays = Math.floor(diffHours / 24);
        return `${diffDays}d ago`;
    }

    closeBoardManager() {
        const modal = document.getElementById('board-manager-modal');
        if (modal) {
            modal.classList.remove('show');
        }
    }

    createNewBoard() {
        this.showInputDialog('New Board', 'Enter a name for the new board:', 'Untitled Board', async (newName) => {
            if (newName && newName.trim()) {
                const boardName = newName.trim();

                // Save current board first (the new board's state is only swapped in after this finishes)
                await this.saveCurrentBoard();

                // Create new board with unique ID
                const newBoardId = this.generateBoardId(boardName);
                this.currentBoardId = newBoardId;
                this.currentBoardName = boardName;
                this.tasks = [];
                this.columns = [
                    { id: 'todo', title: 'To Do', order: 0 },
                    { id: 'in-progress', title: 'In Progress', order: 1 },
                    { id: 'done', title: 'Done', order: 2 }
                ];

                // Save the new board and remember it as the open one
                await this.saveCurrentBoard();
                this.storage.setCurrentBoardId(newBoardId);

                // Update UI
                this.updateBoardNameInput();
                this.renderBoard();
                this.closeBoardManager();
                this.showToast(`Created new board: ${boardName}`, 'success');
            }
        });
    }

    duplicateCurrentBoard() {
        this.showInputDialog('Duplicate Board', 'Enter a name for the duplicated board:', this.currentBoardName + ' Copy', async (newName) => {
            if (newName && newName.trim()) {
                const boardName = newName.trim();
                const newBoardId = this.generateBoardId(boardName);
            
                const duplicatedBoard = {
                    id: newBoardId,
                    name: boardName,
                    tasks: JSON.parse(JSON.stringify(this.tasks)),
                    columns: JSON.parse(JSON.stringify(this.columns)),
                    lastModified: new Date().toISOString(),
                    createdAt: new Date().toISOString()
                };
                
                this.savedBoards[newBoardId] = duplicatedBoard;
                if (!(await this.saveBoardsToStorage([newBoardId]))) {
                    delete this.savedBoards[newBoardId];
                    return;
                }
                this.closeBoardManager();
                this.showToast(`Duplicated board: ${boardName}`, 'success');
            }
        });
    }

    switchToBoard(boardId) {
        const targetBoard = this.savedBoards[boardId];
        if (!targetBoard) return;
        
        if (!this.isSaved()) {
            this.showConfirmDialog('Switch Board', `Switch to "${targetBoard.name}"?\n\nYou have unsaved changes. They will be saved before switching.`, (confirmed) => {
                if (confirmed) {
                    this.performBoardSwitch(boardId);
                }
            });
        } else {
            this.performBoardSwitch(boardId);
        }
    }

    async performBoardSwitch(boardId) {
        const targetBoard = this.savedBoards[boardId];
        if (!targetBoard) return;

        // Save current board
        await this.saveCurrentBoard();
        
        // Load new board
        this.loadBoard(boardId);
        this.closeBoardManager();
    }

    deleteBoard(boardId) {
        const stored = this.savedBoards[boardId];
        if (!stored) return;
        // There must always be at least one board
        if (Object.keys(this.savedBoards).length <= 1) {
            this.showToast('Cannot delete the last board', 'error');
            return;
        }
        const isCurrent = boardId === this.currentBoardId;
        // The open board goes to the trash exactly as it is right now, unsaved edits included
        const board = isCurrent
            ? { ...stored, id: boardId, name: this.currentBoardName, tasks: this.tasks, columns: this.columns, lastModified: new Date().toISOString() }
            : stored;
        const message = isCurrent
            ? `Move the current board "${board.name}" to the trash?\n\nAnother board will open in its place. You can restore this one later from Manage boards > Trash.`
            : `Move the board "${board.name}" to the trash?\n\nYou can restore it later from Manage boards > Trash.`;

        this.showConfirmDialog('Move to trash', message, async (confirmed) => {
            if (!confirmed) return;

            // Which board takes over: the one after it in the list, else the one before, else a fresh one
            let nextId = null;
            if (isCurrent) {
                const ids = this.getOrderedBoardIds();
                const i = ids.indexOf(boardId);
                nextId = ids[i + 1] || ids[i - 1] || null;
            }

            // The adapter copies it to the trash first, then removes it, and undoes the copy if that fails
            try {
                this.trash[boardId] = await this.storage.trashBoard({ ...board, id: boardId });
            } catch (e) {
                this.showToast(`Could not move to trash: ${e.message}`, 'error');
                return;
            }

            delete this.savedBoards[boardId];
            if (isCurrent) this.loadBoard(nextId, true);
            this.refreshBoardManager();
            this.renderRail();
            this.showToast(isCurrent
                ? `Moved to trash: ${board.name}. Opened ${this.currentBoardName}`
                : `Moved to trash: ${board.name}`, 'info');
        });
    }

    // Column Management
    // Columns are now saved with boards, these are deprecated
    loadColumnsFromStorage() {
        // Deprecated - columns are loaded with boards
    }

    saveColumnsToStorage() {
        // Deprecated - columns are saved with boards
        // Just save the current board instead
        this.commit();
    }

    openColumnModal(columnId = null) {
        // Create modal if it doesn't exist
        let modal = document.getElementById('column-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'column-modal';
            modal.className = 'modal anchored';
            modal.innerHTML = `
                <div class="modal-content">
                    <div class="modal-header">
                        <h2 class="modal-title" id="column-modal-title">New stage</h2>
                    </div>
                    <form id="column-form" onsubmit="kanban.saveColumn(event)">
                        <div class="form-group">
                            <label class="form-label" for="column-title">Stage name</label>
                            <input type="text" class="form-input" id="column-title" required maxlength="50" placeholder="e.g., In review">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Color</label>
                            <div class="color-picker-container">
                                <button type="button" class="color-option" data-color="" title="Default (no color)" onclick="kanban.selectColumnColor('')">
                                    <span class="color-circle no-color">✕</span>
                                </button>
                                <button type="button" class="color-option" data-color="#ef4444" title="Red" onclick="kanban.selectColumnColor('#ef4444')">
                                    <span class="color-circle" style="background: #ef4444"></span>
                                </button>
                                <button type="button" class="color-option" data-color="#f97316" title="Orange" onclick="kanban.selectColumnColor('#f97316')">
                                    <span class="color-circle" style="background: #f97316"></span>
                                </button>
                                <button type="button" class="color-option" data-color="#eab308" title="Yellow" onclick="kanban.selectColumnColor('#eab308')">
                                    <span class="color-circle" style="background: #eab308"></span>
                                </button>
                                <button type="button" class="color-option" data-color="#22c55e" title="Green" onclick="kanban.selectColumnColor('#22c55e')">
                                    <span class="color-circle" style="background: #22c55e"></span>
                                </button>
                                <button type="button" class="color-option" data-color="#3b82f6" title="Blue" onclick="kanban.selectColumnColor('#3b82f6')">
                                    <span class="color-circle" style="background: #3b82f6"></span>
                                </button>
                                <button type="button" class="color-option" data-color="#a855f7" title="Purple" onclick="kanban.selectColumnColor('#a855f7')">
                                    <span class="color-circle" style="background: #a855f7"></span>
                                </button>
                                <button type="button" class="color-option" data-color="#ec4899" title="Pink" onclick="kanban.selectColumnColor('#ec4899')">
                                    <span class="color-circle" style="background: #ec4899"></span>
                                </button>
                                <button type="button" class="color-option" data-color="#6b7280" title="Gray" onclick="kanban.selectColumnColor('#6b7280')">
                                    <span class="color-circle" style="background: #6b7280"></span>
                                </button>
                                <button type="button" class="color-option custom-color" title="Custom Color" onclick="kanban.openCustomColumnColorPicker()">
                                    <span class="color-circle custom">+</span>
                                </button>
                            </div>
                            <input type="hidden" id="column-color" value="">
                        </div>
                        <div class="modal-actions">
                            <button type="button" class="btn btn-secondary" onclick="kanban.closeColumnModal()">Cancel</button>
                            <button type="submit" class="btn">Save stage</button>
                        </div>
                    </form>
                </div>
            `;
            document.body.appendChild(modal);
        }

        this.currentColumnId = columnId;
        // Editing: beside the stage header. Adding: beside the "Add a stage" button
        const anchor = columnId
            ? document.querySelector(`.column[data-column="${CSS.escape(columnId)}"] .lane-head`)
            : this.recentClickEl();
        const title = document.getElementById('column-modal-title');
        const form = document.getElementById('column-form');

        if (columnId) {
            const column = this.columns.find(c => c.id === columnId);
            if (column) {
                title.textContent = 'Edit stage';
                document.getElementById('column-title').value = column.title;
                const color = column.color || '';
                document.getElementById('column-color').value = color;
                this.updateColumnColorPickerSelection(color);
            }
        } else {
            title.textContent = 'New stage';
            form.reset();
            document.getElementById('column-color').value = '';
            this.updateColumnColorPickerSelection('');
        }

        this.showAnchoredModal(modal, anchor);
        const nameField = document.getElementById('column-title');
        if (nameField) nameField.focus();
    }

    closeColumnModal() {
        const modal = document.getElementById('column-modal');
        if (modal) {
            modal.classList.remove('show');
        }
        this.currentColumnId = null;
    }

    saveColumn(event) {
        event.preventDefault();
        
        const title = document.getElementById('column-title').value.trim();
        if (!title) return;
        const color = document.getElementById('column-color').value || '';

        if (this.currentColumnId) {
            // Edit existing column
            const column = this.columns.find(c => c.id === this.currentColumnId);
            if (column) {
                column.title = title;
                column.color = color;
            }
        } else {
            // Add new column
            const newColumn = {
                id: 'col-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
                title: title,
                order: this.columns.length,
                color: color
            };
            this.columns.push(newColumn);
        }

        this.saveColumnsToStorage();
        this.renderBoard();
        this.closeColumnModal();
        this.showToast(this.currentColumnId ? 'Stage updated' : 'Stage created', 'success');
    }

    editColumn(columnId) {
        this.openColumnModal(columnId);
    }

    deleteColumn(columnId) {
        // Don't allow deleting if it's the only column
        if (this.columns.length <= 1) {
            this.showToast('Cannot delete the last stage', 'error');
            return;
        }

        const column = this.columns.find(c => c.id === columnId);
        if (!column) return;

        const tasksInColumn = this.tasks.filter(t => t.column === columnId);
        
        let confirmMessage = `Are you sure you want to delete the "${column.title}" stage?`;
        if (tasksInColumn.length > 0) {
            confirmMessage += `\n\nThis stage contains ${tasksInColumn.length} task(s). They will be moved to the first stage.`;
        }

        this.showConfirmDialog('Delete stage', confirmMessage, (confirmed) => {
            if (confirmed) {
                // Move tasks to the first column
                if (tasksInColumn.length > 0) {
                    const firstColumn = this.columns.find(c => c.id !== columnId);
                    tasksInColumn.forEach(task => {
                        task.column = firstColumn.id;
                    });
                }

                // Remove column
                this.columns = this.columns.filter(c => c.id !== columnId);
            
            // Reorder remaining columns
            this.columns.forEach((col, index) => {
                col.order = index;
            });

                this.saveColumnsToStorage();
                this.commit();
                this.renderBoard();
                this.showToast('Stage deleted', 'info');
            }
        });
    }

    // Storage Management
    async saveToStorage() {
        if (this.isDraft()) { // signed out: saving needs an account
            this.requestSignIn('Your boards are not saved yet. Sign in to save them.');
            return;
        }
        // Saves the current board (merged into whatever is already stored)
        if (await this.saveCurrentBoard()) this.showToast('Board saved', 'success');
    }
    
    getLastSaveInfo() {
        if (!this.currentBoardId || !this.savedBoards[this.currentBoardId]) {
            return 'Not saved yet';
        }
        
        const board = this.savedBoards[this.currentBoardId];
        const lastSave = board.lastModified;
        if (!lastSave) {
            return 'Not saved yet';
        }
        
        const saveDate = new Date(lastSave);
        const now = new Date();
        const diffMs = now - saveDate;
        const diffSecs = Math.floor(diffMs / 1000);
        const diffMins = Math.floor(diffSecs / 60);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);
        
        if (diffSecs < 60) {
            return 'Saved just now';
        } else if (diffMins < 60) {
            return `Saved ${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
        } else if (diffHours < 24) {
            return `Saved ${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
        } else {
            return `Saved ${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
        }
    }

    loadFromStorage() {
        // Legacy method - now redirects to loadCurrentBoard
        // Kept for compatibility but uses new system
        this.loadCurrentBoard();
        this.renderBoard();
        return true;
    }

    clearBoard() {
        this.showConfirmDialog('Clear Board', 'Are you sure you want to clear all tasks? This cannot be undone.', (confirmed) => {
            if (confirmed) {
                this.tasks = [];
                this.commit();
                this.renderBoard();
                this.showToast('Board cleared', 'info');
            }
        });
    }

    // Import/Export
    exportBoard() {
        const data = {
            // Board metadata
            name: this.currentBoardName,
            boardId: this.currentBoardName.toLowerCase().replace(/[^a-z0-9]/g, '-'),
            
            // Board content
            tasks: this.tasks,
            columns: this.columns,
            
            // Export metadata
            exportDate: new Date().toISOString(),
            version: '2.0',
            
            // User preferences (optional)
            preferences: {
                theme: this.currentTheme,
                density: this.currentDensity
            },
            
            // Statistics
            stats: {
                taskCount: this.tasks.length,
                columnCount: this.columns.length,
                completedTasks: this.tasks.filter(t => {
                    const columnTitle = this.columns.find(c => c.id === t.column)?.title.toLowerCase() || '';
                    return columnTitle.includes('done') || columnTitle.includes('complete') || t.progress === 100;
                }).length
            }
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        
        // Use board name in filename, sanitized for file system
        const safeBoardName = this.currentBoardName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
        const dateString = new Date().toISOString().split('T')[0];
        a.download = `${safeBoardName}-${dateString}.json`;
        
        a.click();
        URL.revokeObjectURL(url);
        
        this.showToast(`Board "${this.currentBoardName}" exported successfully`, 'success');
    }

    importBoard() {
        document.getElementById('import-input').click();
    }

    handleImport(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                
                // Check if it's a valid board export
                if (!data.tasks || !Array.isArray(data.tasks)) {
                    throw new Error('Invalid file format - missing tasks array');
                }

                // Determine export version and handle accordingly
                const version = data.version || '1.0';
                let importedBoardName = 'Imported Board';
                let importedColumns = [];
                let importedTasks = [];
                let preferences = null;

                if (version === '2.0') {
                    // New format with full board data
                    importedBoardName = data.name || 'Imported Board';
                    importedColumns = data.columns || [];
                    importedTasks = data.tasks;
                    preferences = data.preferences;
                } else {
                    // Legacy format (v1.0) - only tasks
                    importedTasks = data.tasks;
                    importedColumns = [
                        { id: 'todo', title: 'To Do', order: 0 },
                        { id: 'in-progress', title: 'In Progress', order: 1 },
                        { id: 'done', title: 'Done', order: 2 }
                    ];
                }

                // Validate imported tasks
                importedTasks = importedTasks.filter(task => 
                    task && typeof task === 'object' && task.id && task.title
                );

                // Validate imported columns
                if (importedColumns.length === 0) {
                    importedColumns = [
                        { id: 'todo', title: 'To Do', order: 0 },
                        { id: 'in-progress', title: 'In Progress', order: 1 },
                        { id: 'done', title: 'Done', order: 2 }
                    ];
                }

                // Ask user what to do with the import
                const options = [
                    'Import as new board',
                    'Replace current board',
                    'Cancel import'
                ];

                this.showChoiceDialog(
                    'Import Board',
                    `Import "${importedBoardName}"?\n\nFound ${importedTasks.length} tasks and ${importedColumns.length} stages.\n\nWhat would you like to do?`,
                    options,
                    async (choice) => {
                        if (choice === 0) {
                            // 1. Import as new board
                            let newBoardName = importedBoardName;

                            // Ensure unique name
                            let counter = 1;
                            while (Object.values(this.savedBoards).some(b => b.name === newBoardName)) {
                                newBoardName = `${importedBoardName} (${counter})`;
                                counter++;
                            }

                            // Save current board first
                            await this.saveCurrentBoard();

                            // Create new board with imported data (real id, like every other board)
                            const newBoardId = this.generateBoardId(newBoardName);
                            const now = new Date().toISOString();
                            this.savedBoards[newBoardId] = {
                                id: newBoardId,
                                name: newBoardName,
                                tasks: importedTasks,
                                columns: importedColumns,
                                lastModified: now,
                                createdAt: now
                            };
                            if (!(await this.saveBoardsToStorage([newBoardId]))) {
                                delete this.savedBoards[newBoardId];
                                return;
                            }

                            this.loadBoard(newBoardId, true);
                            this.showToast(`Board imported as "${newBoardName}"`, 'success');
                        } else if (choice === 1) {
                            // 2. Replace current board — ask for overwrite confirmation first
                            this.showConfirmDialog(
                                'Overwrite Current Board',
                                `Are you sure you want to overwrite "${this.currentBoardName}" with "${importedBoardName}"?\n\nAll current tasks and stages on this board will be replaced. This action cannot be undone.`,
                                (confirmed) => {
                                    if (!confirmed) return;

                                    this.currentBoardName = importedBoardName;
                                    this.tasks = importedTasks;
                                    this.columns = importedColumns;

                                    // Apply preferences if available
                                    if (preferences) {
                                        if (preferences.theme && ['white', 'grey', 'black'].includes(preferences.theme)) {
                                            this.changeTheme(preferences.theme);
                                            this.updateThemeButton();
                                        }
                                        if (preferences.density && ['comfortable', 'compact', 'dense'].includes(preferences.density)) {
                                            this.changeDensity(preferences.density);
                                            this.updateDensityButton();
                                        }
                                    }

                                    // Update UI
                                    this.updateBoardNameInput();
                                    this.renderBoard();
                                    this.commit();
                                    this.saveColumnsToStorage();
                                    this.commit();
                                    this.showToast(`Board replaced with "${importedBoardName}"`, 'success');
                                }
                            );
                        } else {
                            // 3. Cancel import
                            this.showToast('Import cancelled', 'info');
                        }
                    }
                );

            } catch (error) {
                console.error('Import failed:', error);
                this.showToast(`Failed to import board: ${error.message}`, 'error');
            }
        };
        reader.readAsText(file);
        
        // Reset the input
        event.target.value = '';
    }

    // Custom choice dialog to replace askUserChoice
    showChoiceDialog(title, message, options, callback) {
        let dialog = document.getElementById('choice-dialog');
        if (!dialog) {
            dialog = document.createElement('div');
            dialog.id = 'choice-dialog';
            dialog.className = 'modal';
            dialog.innerHTML = `
                <div class="modal-content modal-small">
                    <div class="modal-header">
                        <h2 class="modal-title" id="choice-dialog-title"></h2>
                        <button class="modal-close" onclick="kanban.closeChoiceDialog()">×</button>
                    </div>
                    <div class="modal-body">
                        <p id="choice-dialog-message" style="white-space:pre-line"></p>
                        <div id="choice-dialog-options" class="choice-options"></div>
                    </div>
                </div>
            `;
            dialog.addEventListener('click', (e) => {
                if (e.target === dialog) this.closeChoiceDialog();
            });
            document.body.appendChild(dialog);
        }
        
        document.getElementById('choice-dialog-title').textContent = title;
        document.getElementById('choice-dialog-message').textContent = message;
        
        const optionsContainer = document.getElementById('choice-dialog-options');
        optionsContainer.innerHTML = options.map((option, index) => {
            const isCancel = /^cancel/i.test(option);
            const btnClass = isCancel ? 'btn btn-secondary choice-btn' : 'btn choice-btn';
            return `<button type="button" class="${btnClass}" onclick="kanban.selectChoice(${index})">${this.escapeHtml(option)}</button>`;
        }).join('');
        
        this.choiceDialogCallback = callback;
        dialog.classList.add('show');
    }
    
    closeChoiceDialog() {
        const dialog = document.getElementById('choice-dialog');
        if (dialog) {
            dialog.classList.remove('show');
            this.choiceDialogCallback = null;
        }
    }
    
    selectChoice(index) {
        const cb = this.choiceDialogCallback;
        this.closeChoiceDialog();
        if (cb) {
            cb(index);
        }
    }

    // Task Management
    openTaskModal(column, taskId = null) {
        this.currentColumn = column;
        this.currentTaskId = taskId;
        
        const modal = document.getElementById('task-modal');
        const title = document.getElementById('modal-title');
        const form = document.getElementById('task-form');
        // Editing: beside the card. Adding: beside the "Add card" button
        const anchor = taskId
            ? document.querySelector(`.task-card[data-task-id="${CSS.escape(taskId)}"]`)
            : this.recentClickEl();
        
        if (taskId) {
            const task = this.tasks.find(t => t.id === taskId);
            if (task) {
                title.textContent = 'Edit Task';
                this.populateTaskForm(task);
            }
        } else {
            title.textContent = 'New Task';
            form.reset();
            // Reset slider displays
            document.getElementById('task-difficulty').nextElementSibling.textContent = '3 / 5';
            document.getElementById('task-progress').nextElementSibling.textContent = '0%';
            // Reset color to no color
            document.getElementById('task-color').value = '';
            this.updateColorPickerSelection('');
            this.setTaskPriority('medium');
        }
        
        this.showAnchoredModal(modal, anchor);
    }

    // Priority is a three-way toggle (same look as the sidebar toggles); the hidden input keeps the value
    setTaskPriority(value) {
        if (!['low', 'medium', 'high'].includes(value)) value = 'medium';
        document.getElementById('task-priority').value = value;
        document.querySelectorAll('#task-priority-seg [data-prio-opt]').forEach(btn => {
            btn.setAttribute('aria-pressed', btn.dataset.prioOpt === value ? 'true' : 'false');
        });
    }

    populateTaskForm(task) {
        document.getElementById('task-title').value = task.title || '';
        document.getElementById('task-description').value = task.description || '';
        
        const difficultySlider = document.getElementById('task-difficulty');
        const progressSlider = document.getElementById('task-progress');
        
        difficultySlider.value = task.difficulty || 3;
        progressSlider.value = task.progress || 0;
        
        // Update displays
        difficultySlider.nextElementSibling.textContent = `${task.difficulty || 3} / 5`;
        progressSlider.nextElementSibling.textContent = `${task.progress || 0}%`;
        
        this.setTaskPriority(task.priority || 'medium');
        
        // Set task color
        const color = (task.color === undefined || task.color === null) ? '#3b82f6' : task.color;
        document.getElementById('task-color').value = color;
        this.updateColorPickerSelection(color);
    }

    closeTaskModal() {
        document.getElementById('task-modal').classList.remove('show');
        this.currentTaskId = null;
    }

    saveTask(event) {
        event.preventDefault();
        
        const taskData = {
            id: this.currentTaskId || 'task-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            title: document.getElementById('task-title').value,
            description: document.getElementById('task-description').value,
            column: this.currentColumn,
            difficulty: parseInt(document.getElementById('task-difficulty').value),
            progress: parseInt(document.getElementById('task-progress').value),
            priority: document.getElementById('task-priority').value,
            color: document.getElementById('task-color').value,
            createdAt: this.currentTaskId ? 
                (this.tasks.find(t => t.id === this.currentTaskId)?.createdAt || new Date().toISOString()) : 
                new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        if (this.currentTaskId) {
            const index = this.tasks.findIndex(t => t.id === this.currentTaskId);
            if (index !== -1) {
                // Preserve the column if editing
                const old = this.tasks[index];
                taskData.column = old.column;
                if (old.order !== undefined) taskData.order = old.order;
                // Keep the done state unless the progress slider was moved off 100%
                if (old.done && taskData.progress === 100) {
                    taskData.done = true;
                    if (old.prevProgress !== undefined) taskData.prevProgress = old.prevProgress;
                }
                this.tasks[index] = taskData;
            }
        } else {
            this.tasks.push(taskData);
        }
        
        const isEditing = this.currentTaskId !== null;
        
        this.renderBoard();
        this.commit();
        this.closeTaskModal();
        this.showToast(isEditing ? 'Task updated' : 'Task created', 'success');
    }

    deleteTask(taskId) {
        this.showConfirmDialog('Delete Task', 'Are you sure you want to delete this task?', (confirmed) => {
            if (confirmed) {
                this.tasks = this.tasks.filter(t => t.id !== taskId);
                this.renderBoard();
                this.commit();
                this.showToast('Task deleted', 'info');
            }
        });
    }

    // Order of tasks inside one stage: manual order (set by dragging) wins;
    // tasks that were never placed manually (e.g. new ones) sit on top, by priority then newest.
    compareTasks(a, b) {
        const aSet = a.order !== undefined, bSet = b.order !== undefined;
        if (aSet && bSet && a.order !== b.order) return a.order - b.order;
        if (aSet !== bSet) return aSet ? 1 : -1;
        const rank = { high: 0, medium: 1, low: 2 };
        return (rank[a.priority] - rank[b.priority]) || (new Date(b.createdAt) - new Date(a.createdAt));
    }

    sortedTasksInColumn(columnId) {
        return this.tasks.filter(t => t.column === columnId && !t.archived).sort((a, b) => this.compareTasks(a, b));
    }

    moveTask(taskId, newColumn, beforeTaskId = null) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) return false;
        const oldColumn = task.column;
        const changedColumn = oldColumn !== newColumn;

        // Work out the new sequence of the target stage
        const currentSeq = this.sortedTasksInColumn(newColumn);
        const seq = currentSeq.filter(t => t.id !== taskId);
        let index = beforeTaskId ? seq.findIndex(t => t.id === beforeTaskId) : -1;
        if (index < 0) index = seq.length;
        seq.splice(index, 0, task);

        if (!changedColumn && seq.every((t, i) => t.id === currentSeq[i].id)) return false; // dropped where it already was

        if (changedColumn) {
            task.column = newColumn;
            task.updatedAt = new Date().toISOString();
        }

        seq.forEach((t, i) => { t.order = i; });

        this.renderBoard();
        this.commit();
        this.showToast(changedColumn ? `Task moved to ${this.columns.find(c => c.id === newColumn)?.title}` : 'Task reordered', 'success');
        return true;
    }

    // Done checkbox: checking sets progress to 100%; unchecking restores the exact previous value
    setTaskDone(task, done) {
        if (!!task.done === done) return;
        if (done) {
            task.prevProgress = task.progress;
            task.progress = 100;
            task.done = true;
        } else {
            task.progress = task.prevProgress !== undefined ? task.prevProgress : task.progress;
            task.done = false;
            delete task.prevProgress;
        }
        task.updatedAt = new Date().toISOString();
    }

    toggleDone(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) return;
        this.setTaskDone(task, !task.done);
        this.renderBoard();
        this.commit();
    }

    // Stage menu: if any card in the stage is not done, mark them all done; otherwise mark them all undone
    toggleAllDone(columnId) {
        const list = this.tasks.filter(t => t.column === columnId && !t.archived);
        if (!list.length) return;
        const markDone = list.some(t => !t.done);
        list.forEach(t => this.setTaskDone(t, markDone));
        this.renderBoard();
        this.commit();
        this.showToast(markDone ? 'All cards in this stage marked as done' : 'All cards in this stage marked as undone', 'success');
    }

    // ───────────── Archive ─────────────
    archiveTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task || task.archived) return;
        task.archived = true;
        task.archivedAt = new Date().toISOString();
        this.renderBoard();
        this.commit();
        this.showToast('Task archived', 'success');
    }

    archiveAllDone() {
        const list = this.tasks.filter(t => t.done && !t.archived);
        if (!list.length) {
            this.showToast('No tasks marked as done', 'info');
            return;
        }
        this.showConfirmDialog('Archive done tasks', `Archive ${list.length} task${list.length === 1 ? '' : 's'} marked as done?\n\nYou can restore them from Archived cards.`, (confirmed) => {
            if (!confirmed) return;
            const now = new Date().toISOString();
            list.forEach(t => { t.archived = true; t.archivedAt = now; });
            this.renderBoard();
            this.commit();
            document.body.classList.remove('rail-open');
            this.showToast(`Archived ${list.length} task${list.length === 1 ? '' : 's'}`, 'success');
        });
    }

    restoreTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task || !task.archived) return;
        // Back to its original stage, or the first stage if that one no longer exists
        if (!this.columns.some(c => c.id === task.column)) {
            task.column = [...this.columns].sort((a, b) => a.order - b.order)[0].id;
        }
        task.order = this.sortedTasksInColumn(task.column).length; // bottom of the stage
        delete task.archived;
        delete task.archivedAt;
        this.renderBoard();
        this.commit();
        this.showToast('Task restored', 'success');
    }

    clearArchive() {
        const n = this.tasks.filter(t => t.archived).length;
        if (!n) return;
        this.showConfirmDialog('Clear archive', `Permanently delete ${n} archived task${n === 1 ? '' : 's'}?\n\nThis action cannot be undone.`, (confirmed) => {
            if (!confirmed) return;
            this.tasks = this.tasks.filter(t => !t.archived);
            this.renderBoard();
            this.commit();
            this.showToast('Archive cleared', 'info');
        });
    }

    openArchiveModal() {
        document.body.classList.remove('rail-open');
        let modal = document.getElementById('archive-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'archive-modal';
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content modal-compact">
                    <div class="modal-header">
                        <h2 class="modal-title">Archived cards</h2>
                        <button class="modal-close" onclick="kanban.closeArchiveModal()">×</button>
                    </div>
                    <div class="board-actions-row">
                        <button class="btn btn-sm btn-secondary" id="archive-clear" onclick="kanban.clearArchive()">Clear archive</button>
                    </div>
                    <div id="archive-list"></div>
                </div>`;
            document.body.appendChild(modal);
            modal.addEventListener('click', (e) => { if (e.target === modal) this.closeArchiveModal(); });
        }
        this.refreshArchiveModal();
        modal.classList.add('show');
    }

    closeArchiveModal() {
        const modal = document.getElementById('archive-modal');
        if (modal) modal.classList.remove('show');
    }

    refreshArchiveModal() {
        const modal = document.getElementById('archive-modal');
        if (!modal) return;
        const list = this.tasks.filter(t => t.archived)
            .sort((a, b) => new Date(b.archivedAt || 0) - new Date(a.archivedAt || 0));
        modal.querySelector('#archive-clear').disabled = !list.length;
        modal.querySelector('#archive-list').innerHTML = list.length ? list.map(t => {
            const stage = this.columns.find(c => c.id === t.column)?.title || '';
            const when = t.archivedAt ? new Date(t.archivedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown';
            return `
                <div class="archive-item">
                    <div class="archive-info">
                        <span class="archive-title">${this.escapeHtml(t.title)}</span>
                        <span class="archive-meta">${stage ? this.escapeHtml(stage) + ' · ' : ''}Archived ${when}</span>
                    </div>
                    <button class="btn-compact" onclick="kanban.restoreTask('${t.id}')">Restore</button>
                </div>`;
        }).join('') : '<div class="empty-state-compact">No archived cards</div>';
    }

    // Search
    openSearch() {
        document.getElementById('search-modal').classList.add('show');
        document.getElementById('search-input').focus();
    }

    closeSearchModal() {
        document.getElementById('search-modal').classList.remove('show');
        document.getElementById('search-input').value = '';
        document.getElementById('search-results').innerHTML = '';
    }

    searchTasks(term) {
        this.searchTerm = term.toLowerCase();
        const results = document.getElementById('search-results');
        
        if (!term) {
            results.innerHTML = '';
            return;
        }
        
        const matches = this.tasks.filter(task => !task.archived && 
            task.title.toLowerCase().includes(this.searchTerm) ||
            task.description.toLowerCase().includes(this.searchTerm) ||
            (task.categories && task.categories.some(cat => cat.toLowerCase().includes(this.searchTerm)))
        );
        
        if (matches.length === 0) {
            results.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">No tasks found</p>';
            return;
        }
        
        results.innerHTML = matches.map(task => `
            <div class="search-result" onclick="kanban.highlightTask('${task.id}')">
                <div style="font-weight: 600;">${task.title}</div>
                <div style="font-size: 0.875rem; color: var(--text-secondary);">
                    ${task.column.replace('-', ' ').toUpperCase()} • Priority: ${task.priority}
                </div>
            </div>
        `).join('');
    }

    highlightTask(taskId) {
        this.closeSearchModal();
        const taskElement = document.querySelector(`[data-task-id="${taskId}"]`);
        if (taskElement) {
            taskElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            taskElement.style.animation = 'pulse 2s';
            setTimeout(() => {
                taskElement.style.animation = '';
            }, 2000);
        }
    }

    // Rendering
    renderBoard() {
        const boardContainer = document.querySelector('.board');
        if (!boardContainer) return;
        // Keep each stage's horizontal scroll position across re-renders (no jump after a drop)
        const scrolls = {};
        boardContainer.querySelectorAll('.column').forEach(col => {
            const z = col.querySelector('.tasks-container');
            if (z && z.scrollLeft) scrolls[col.dataset.column] = z.scrollLeft;
        });
        const sorted = [...this.columns].sort((a, b) => a.order - b.order);
        const horiz = this.currentView === 'columns';
        const lanes = sorted.map((column, i) => {
            const id = column.id;
            const tasks = this.sortedTasksInColumn(id);
            const allDone = tasks.length > 0 && tasks.every(t => t.done);
            return `
            <section class="column lane" id="lane-${id}" data-column="${id}" style="--c:${column.color || '#8A96AB'}">
                <div class="lane-head">
                    <div class="lane-top">
                        <span class="lane-dot"></span>
                        <h2 class="column-title">${this.escapeHtml(column.title)}</h2>
                        <div class="column-menu-container">
                            <button class="btn-icon column-menu-btn" onclick="kanban.toggleColumnMenu('${id}')" title="Stage options" aria-label="Stage options">⋯</button>
                            <div class="column-menu" id="menu-${id}">
                                <button class="column-menu-item" onclick="kanban.toggleAllDone('${id}'); kanban.closeColumnMenus();" ${tasks.length ? '' : 'disabled'}>${allDone ? 'Mark all as undone' : 'Mark all as done'}</button>
                                <div class="column-menu-sep" role="separator"></div>
                                <button class="column-menu-item" onclick="kanban.moveColumnLeft('${id}'); kanban.closeColumnMenus();" ${i === 0 ? 'disabled' : ''}>${horiz ? '← Move left' : '↑ Move up'}</button>
                                <button class="column-menu-item" onclick="kanban.moveColumnRight('${id}'); kanban.closeColumnMenus();" ${i === sorted.length - 1 ? 'disabled' : ''}>${horiz ? '→ Move right' : '↓ Move down'}</button>
                                <button class="column-menu-item" onclick="kanban.editColumn('${id}'); kanban.closeColumnMenus();">Rename or recolor</button>
                                <button class="column-menu-item danger" onclick="kanban.deleteColumn('${id}'); kanban.closeColumnMenus();">Delete stage</button>
                            </div>
                        </div>
                    </div>
                    <span class="lane-count">${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}</span>
                    <button class="lane-add" onclick="kanban.openTaskModal('${id}')">Add card</button>
                </div>
                <div class="tasks-container">
                    ${tasks.length ? tasks.map(t => this.renderTaskCard(t)).join('') : '<span class="empty">No tasks yet. Drop one here.</span>'}
                </div>
            </section>`;
        }).join('');
        boardContainer.innerHTML = lanes + `
            <div class="add-lane"><button class="add-column-btn" onclick="kanban.openColumnModal()">Add a stage</button></div>`;

        boardContainer.querySelectorAll('.column').forEach(col => {
            const z = col.querySelector('.tasks-container');
            if (z && scrolls[col.dataset.column]) z.scrollLeft = scrolls[col.dataset.column];
        });

        this.renderRail();
        this.refreshArchiveModal();
        if (this.searchTerm) this.filterTasks();
    }

    renderRail() {
        const boards = document.getElementById('rail-boards');
        if (!boards) return;
        boards.innerHTML = this.getOrderedBoardIds().map(id => {
            const b = this.savedBoards[id];
            const cur = id === this.currentBoardId;
            const name = this.escapeHtml(cur ? this.currentBoardName : b.name);
            const n = cur ? this.tasks.filter(t => !t.archived).length : (b.tasks || []).filter(t => !t.archived).length;
            return `<button class="rail-item${cur ? ' on' : ''}" ${cur ? '' : `onclick="kanban.switchToBoard('${id}')"`}><span class="g">${name}</span><em>${n}</em></button>`;
        }).join('');
        const active = this.tasks.filter(t => !t.archived);
        const done = active.filter(t => t.progress >= 100).length;
        const summary = document.getElementById('summary');
        if (summary) summary.textContent = `${active.length} tasks, ${done} finished`;
        const doneCount = active.filter(t => t.done).length;
        const archivedCount = this.tasks.length - active.length;
        const setBadge = (id, n) => {
            const b = document.getElementById(id);
            const badge = b && b.querySelector('.badge');
            if (!badge) return;
            badge.textContent = n > 99 ? '99+' : n;
            badge.hidden = !n;
        };
        setBadge('archive-done-button', doneCount);
        setBadge('archived-button', archivedCount);
        const doneBtn = document.getElementById('archive-done-button');
        if (doneBtn) {
            doneBtn.classList.toggle('is-idle', !doneCount);
            const t = doneCount ? `Archive ${doneCount} done task${doneCount === 1 ? '' : 's'}` : 'Archive all done tasks (none marked as done yet)';
            doneBtn.title = t;
            doneBtn.setAttribute('aria-label', t);
        }
        const arcBtn = document.getElementById('archived-button');
        if (arcBtn) {
            const t = archivedCount ? `Archived cards (${archivedCount})` : 'Archived cards';
            arcBtn.title = t;
            arcBtn.setAttribute('aria-label', t);
        }
    }

    renderTaskCard(task) {
        const color = (task.color === undefined || task.color === null) ? '#3b82f6' : task.color;
        const prio = { high: 'High', medium: 'Med', low: 'Low' }[task.priority] || task.priority;
        const pips = [1, 2, 3, 4, 5].map(n => `<i class="${n <= task.difficulty ? 'f' : ''}"></i>`).join('');
        return `
            <article class="task-card${color ? ' colored' : ''}${task.done ? ' done' : ''}" data-task-id="${task.id}" ${color ? `style="--tc:${color}"` : ''}>
                <div class="t-main">
                    <div class="t-head">
                        <input type="checkbox" class="t-check" ${task.done ? 'checked' : ''} onchange="kanban.toggleDone('${task.id}')" title="Mark as done" aria-label="Mark task as done">
                        <h3 class="task-title">${this.escapeHtml(task.title)}</h3>
                    </div>
                    ${task.description ? `<p class="task-description">${this.escapeHtml(task.description)}</p>` : ''}
                </div>
                <div class="t-side">
                    <span class="t-pct">${task.progress}%</span>
                    <span class="t-actions">
                        ${task.done ? `<button onclick="kanban.archiveTask('${task.id}')" title="Archive" aria-label="Archive task"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="3.5" rx="1"/><path d="M2.5 6v6.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6M6.5 9h3"/></svg></button>` : ''}
                        <button onclick="kanban.openTaskModal('${task.column}', '${task.id}')" title="Edit" aria-label="Edit task">✎</button>
                        <button onclick="kanban.deleteTask('${task.id}')" title="Delete" aria-label="Delete task">×</button>
                    </span>
                </div>
                <div class="t-meta">
                    <span class="m-item m-diff"><span class="lbl">Difficulty</span><span class="pips" title="${task.difficulty} of 5">${pips}</span></span>
                    <span class="m-item m-prio"><span class="lbl">Priority</span><span class="prio prio-${task.priority}">${prio}</span></span>
                </div>
                <div class="t-progress" title="Progress"><span class="track"><i style="width:${task.progress}%"></i></span><span>${task.progress}%</span></div>
            </article>`;
    }

    // ───────────────────────── Drag and Drop ─────────────────────────
    // Native HTML5 drag-and-drop can't be animated (the browser paints its own ghost and the
    // drop is instant), so this is pointer based:
    //   1. the pressed card is lifted into a floating clone that follows the pointer
    //   2. the original stays in the list as a dashed "slot" and is moved around live
    //   3. every other card (and lane) glides to its new spot with FLIP animations
    //   4. on release the clone flies into the slot, then the real data update happens
    // Works the same for mouse, pen and touch (touch = press and hold to pick up).

    initializeDragAndDrop() {
        this.dragEase = 'cubic-bezier(.2, .8, .2, 1)';
        this._onMove = (e) => this.onPointerMove(e);
        this._onUp = (e) => this.onPointerUp(e);
        this._onCancel = () => this.abortDrag();
        this._onKey = (e) => {
            if (e.key === 'Escape' && this.drag && this.drag.active) { e.preventDefault(); this.abortDrag(); }
        };

        const board = document.querySelector('.board');
        if (!board) return;
        board.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        board.addEventListener('contextmenu', (e) => {
            if (this.drag && this.drag.type === 'touch') e.preventDefault(); // long-press menu
        });
        // Once a touch drag is running, keep the page from scrolling under the finger
        document.addEventListener('touchmove', (e) => {
            if (this.drag && this.drag.active) e.preventDefault();
        }, { passive: false });
    }

    reduceMotion() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    onPointerDown(e) {
        if (this.drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
        const taskCard = e.target.closest('.task-card');
        const head = taskCard ? null : e.target.closest('.lane-head');
        const card = taskCard || (head && head.closest('.column'));
        if (!card || e.target.closest('button, a, input, textarea, select')) return;

        this.drag = {
            card, kind: taskCard ? 'card' : 'stage', type: e.pointerType, id: e.pointerId,
            x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
            active: false, ending: false, dirty: false, timer: null
        };
        // Touch: hold briefly to pick up, so a normal swipe still scrolls the board
        if (e.pointerType === 'touch') this.drag.timer = setTimeout(() => this.beginDrag(), 220);

        window.addEventListener('pointermove', this._onMove);
        window.addEventListener('pointerup', this._onUp);
        window.addEventListener('pointercancel', this._onCancel);
        window.addEventListener('keydown', this._onKey);
        window.addEventListener('blur', this._onCancel);
    }

    onPointerMove(e) {
        const d = this.drag;
        if (!d || e.pointerId !== d.id) return;
        d.x = e.clientX; d.y = e.clientY; d.dirty = true;
        if (d.active) return;

        const moved = Math.hypot(d.x - d.startX, d.y - d.startY);
        if (d.type === 'touch') {
            if (moved > 8) this.abortDrag(); // finger is scrolling, not dragging
        } else if (moved > 4) {
            this.beginDrag();
        }
    }

    onPointerUp(e) {
        const d = this.drag;
        if (!d || e.pointerId !== d.id) return;
        if (!d.active) { this.abortDrag(); return; } // it was just a click
        this.endDrag();
    }

    teardownDragListeners() {
        window.removeEventListener('pointermove', this._onMove);
        window.removeEventListener('pointerup', this._onUp);
        window.removeEventListener('pointercancel', this._onCancel);
        window.removeEventListener('keydown', this._onKey);
        window.removeEventListener('blur', this._onCancel);
        if (this.drag) clearTimeout(this.drag.timer);
    }

    beginDrag() {
        const d = this.drag;
        if (!d || d.active) return;
        clearTimeout(d.timer);

        const card = d.card;
        const rect = card.getBoundingClientRect();
        d.active = true;
        d.dirty = true;
        d.offX = d.startX - rect.left;
        d.offY = d.startY - rect.top;
        const isStage = d.kind === 'stage';
        d.origin = { parent: card.parentNode, next: card.nextElementSibling };
        d.zone = isStage ? null : card.parentNode;

        // Floating clone that follows the pointer
        const ghost = card.cloneNode(true);
        ghost.removeAttribute('data-task-id');
        ghost.removeAttribute('id');
        ghost.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
        ghost.querySelectorAll('.column-menu.show').forEach(n => n.classList.remove('show'));
        ghost.setAttribute('aria-hidden', 'true');
        if (isStage) ghost.classList.add('stage-ghost');
        ghost.classList.add('drag-ghost');
        ghost.style.width = rect.width + 'px';
        ghost.style.height = rect.height + 'px';
        ghost.style.translate = `${rect.left}px ${rect.top}px`;
        document.body.appendChild(ghost);
        ghost.getBoundingClientRect();      // commit the start state so the lift is a transition
        ghost.classList.add('lifted');
        d.ghost = ghost;

        // The original becomes the slot that shows where the card will land
        this.closeColumnMenus();
        card.classList.add(isStage ? 'is-placeholder-lane' : 'is-placeholder');
        if (d.zone) d.zone.classList.add('drag-over');
        document.body.classList.add('is-dragging');
        if (isStage) document.body.classList.add('is-dragging-stage');
        if (d.type === 'touch' && navigator.vibrate) navigator.vibrate(8);

        this.dragFrame();
    }

    // One frame of the drag: move the ghost, auto-scroll near edges, re-project the slot
    dragFrame() {
        const d = this.drag;
        if (!d || !d.active || d.ending) return;

        d.ghost.style.translate = `${d.x - d.offX}px ${d.y - d.offY}px`;

        let scrolled = false;
        const edge = 80, speed = 16;

        // Page scroll (top and bottom edges of the viewport)
        const vy = d.y < edge ? -(1 - Math.max(d.y, 0) / edge)
            : d.y > window.innerHeight - edge ? 1 - Math.max(window.innerHeight - d.y, 0) / edge : 0;
        if (vy) {
            const before = window.scrollY;
            window.scrollBy(0, vy * speed);
            if (window.scrollY !== before) scrolled = true;
        }

        // Horizontal scroll inside the stage under the pointer (lanes layout)
        const zone = d.zone;
        if (zone && zone.scrollWidth > zone.clientWidth) {
            const zr = zone.getBoundingClientRect();
            if (d.y >= zr.top && d.y <= zr.bottom) {
                const fromLeft = d.x - zr.left, fromRight = zr.right - d.x;
                const hx = fromLeft < edge ? -(1 - Math.max(fromLeft, 0) / edge)
                    : fromRight < edge ? 1 - Math.max(fromRight, 0) / edge : 0;
                if (hx) {
                    const before = zone.scrollLeft;
                    zone.scrollLeft += hx * speed;
                    if (zone.scrollLeft !== before) scrolled = true;
                }
            }
        }

        if (d.dirty || scrolled) {
            d.dirty = false;
            this.updatePlacement();
        }
        d.raf = requestAnimationFrame(() => this.dragFrame());
    }

    // Next visible task card after an element (null = it is last)
    nextVisibleCard(el) {
        let n = el.nextElementSibling;
        while (n && !(n.classList.contains('task-card') && n.offsetParent !== null)) n = n.nextElementSibling;
        return n;
    }

    // The card the dragged task should be inserted before (null = end of stage).
    // Uses layout positions (offset*), not on-screen rects, so cards that are still
    // mid-animation don't make the decision flicker.
    getDropReference(zone, x, y) {
        const vertical = getComputedStyle(zone).flexDirection === 'column';
        const zr = zone.getBoundingClientRect();
        const cards = [...zone.querySelectorAll(':scope > .task-card')]
            .filter(c => !c.classList.contains('is-placeholder') && c.offsetParent !== null);
        for (const c of cards) {
            const mid = vertical
                ? zr.top - zone.scrollTop + c.offsetTop + c.offsetHeight / 2
                : zr.left - zone.scrollLeft + c.offsetLeft + c.offsetWidth / 2;
            if ((vertical ? y : x) < mid) return c;
        }
        return null;
    }

    // Stage drag: the dashed slot moves to the stage under the pointer (before or after it)
    updateStagePlacement() {
        const d = this.drag;
        const board = document.querySelector('.board');
        const ph = d.card;
        const under = document.elementFromPoint(d.x, d.y);
        if (!under || !board.contains(under)) return;

        let ref;
        const other = under.closest('.column');
        if (other && other !== ph) {
            const r = other.getBoundingClientRect();
            const cols = getComputedStyle(board).gridTemplateColumns;
            const sideBySide = getComputedStyle(board).display === 'grid' && cols.split(' ').length > 1;
            const before = sideBySide ? d.x < r.left + r.width / 2 : d.y < r.top + r.height / 2;
            ref = before ? other : other.nextElementSibling;
        } else if (under.closest('.add-lane')) {
            ref = under.closest('.add-lane'); // end of the list
        } else {
            return; // over a gap or the slot itself: keep the current position
        }
        if (ref === ph || ref === ph.nextElementSibling) return; // already projected here
        this.flipMove(() => board.insertBefore(ph, ref), null);
    }

    updatePlacement() {
        if (this.drag.kind === 'stage') { this.updateStagePlacement(); return; }
        const d = this.drag;
        const under = document.elementFromPoint(d.x, d.y);
        const col = under && under.closest('.column');
        // Pointer over a gap or the header: keep the last stage instead of jumping around
        const zone = (col && col.querySelector('.tasks-container')) || d.zone;
        const ph = d.card;
        const ref = this.getDropReference(zone, d.x, d.y);

        if (ph.parentNode === zone && this.nextVisibleCard(ph) === ref) return; // already projected here

        this.flipMove(() => zone.insertBefore(ph, ref), ph);
        this.setDragOver(zone);
    }

    setDragOver(zone) {
        if (this.drag) this.drag.zone = zone;
        document.querySelectorAll('.tasks-container.drag-over').forEach(z => { if (z !== zone) z.classList.remove('drag-over'); });
        zone.classList.add('drag-over');
    }

    // FLIP: record where everything is, change the DOM, then animate each thing from
    // its old on-screen position to its new one. Stages (lanes) animate their height too,
    // so nothing snaps when a card leaves or enters.
    flipMove(mutate, ph) {
        const board = document.querySelector('.board');
        const boxes = [...board.children];
        const cards = [...board.querySelectorAll('.task-card')].filter(c => c.offsetParent !== null);
        const colOf = (c) => c.closest('.column');

        const firstBox = new Map(boxes.map(b => [b, b.getBoundingClientRect()]));
        const firstCard = new Map(cards.map(c => [c, c.getBoundingClientRect()]));
        const colBefore = new Map(cards.map(c => [c, colOf(c)]));

        [...boxes, ...cards].forEach(el => el.getAnimations().forEach(a => a.cancel()));
        mutate();
        if (this.reduceMotion()) return;

        // Measure everything first, animate afterwards (animations would skew later reads)
        const lastBox = new Map(boxes.map(b => [b, b.getBoundingClientRect()]));
        const lastCard = new Map(cards.map(c => [c, c.getBoundingClientRect()]));
        const colAfter = new Map(cards.map(c => [c, colOf(c)]));
        const opts = { duration: 240, easing: this.dragEase };

        boxes.forEach(b => {
            const f = firstBox.get(b), l = lastBox.get(b);
            const dx = f.left - l.left, dy = f.top - l.top, dh = f.height - l.height;
            if (Math.abs(dx) < .5 && Math.abs(dy) < .5 && Math.abs(dh) < .5) return;
            const from = { transform: `translate(${dx}px, ${dy}px)` };
            const to = { transform: 'none' };
            if (Math.abs(dh) >= .5) {
                Object.assign(from, { height: f.height + 'px', overflow: 'hidden', alignContent: 'start' });
                Object.assign(to, { height: l.height + 'px', overflow: 'hidden', alignContent: 'start' });
            }
            b.animate([from, to], opts);
        });

        cards.forEach(c => {
            if (c === ph && colBefore.get(c) !== colAfter.get(c)) {
                // Slot appears in a different stage: fade/scale in rather than fly across the board
                c.animate([{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'none' }], opts);
                return;
            }
            // Movement relative to the stage, because the stage itself is animated above
            const f = firstCard.get(c), l = lastCard.get(c);
            const fb = firstBox.get(colBefore.get(c)) || { left: 0, top: 0 };
            const lb = lastBox.get(colAfter.get(c)) || { left: 0, top: 0 };
            const dx = (f.left - fb.left) - (l.left - lb.left);
            const dy = (f.top - fb.top) - (l.top - lb.top);
            if (Math.abs(dx) < .5 && Math.abs(dy) < .5) return;
            c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], opts);
        });
    }

    // Final on-screen position of an element from layout only (ignores in-flight transforms)
    layoutPos(el) {
        let x = 0, y = 0;
        for (let n = el; n; n = n.offsetParent) {
            x += n.offsetLeft; y += n.offsetTop;
            const p = n.offsetParent;
            if (p) { x += p.clientLeft - p.scrollLeft; y += p.clientTop - p.scrollTop; }
        }
        return { x: x - window.scrollX, y: y - window.scrollY };
    }

    // Fly the ghost into the slot, then call done()
    landGhost(done) {
        const d = this.drag, g = d.ghost;
        if (this.reduceMotion()) { done(); return; }
        const t = this.layoutPos(d.card);
        g.classList.remove('lifted');
        g.classList.add('landing');
        g.style.translate = `${t.x}px ${t.y}px`;

        let finished = false;
        const end = () => {
            if (finished) return;
            finished = true;
            g.removeEventListener('transitionend', onEnd);
            done();
        };
        const onEnd = (e) => { if (e.target === g && e.propertyName === 'translate') end(); };
        g.addEventListener('transitionend', onEnd);
        setTimeout(end, 400); // safety net if transitionend never fires
    }

    endStageDrag() {
        const d = this.drag;
        d.ending = true;
        cancelAnimationFrame(d.raf);
        this.teardownDragListeners();

        this.landGhost(() => {
            const board = document.querySelector('.board');
            const ids = [...board.querySelectorAll(':scope > .column')].map(c => c.dataset.column);
            const before = [...this.columns].sort((a, b) => a.order - b.order).map(c => c.id);
            const changed = ids.some((id, i) => id !== before[i]);

            this.holdScrollSnap();
            document.body.classList.remove('is-dragging', 'is-dragging-stage');
            if (changed) {
                ids.forEach((id, i) => { const c = this.columns.find(x => x.id === id); if (c) c.order = i; });
                this.renderBoard();      // ghost sits exactly over the new stage, so this is seamless
                this.commit();
                this.showToast('Stage moved', 'success');
            } else {
                d.card.classList.remove('is-placeholder-lane');
            }
            d.ghost.remove();
            this.drag = null;
        });
    }

    endDrag() {
        if (this.drag.kind === 'stage') { this.endStageDrag(); return; }
        const d = this.drag;
        d.ending = true;
        cancelAnimationFrame(d.raf);
        this.teardownDragListeners();

        this.landGhost(() => {
            const ph = d.card;
            const zone = ph.parentNode;
            const column = zone.closest('.column').dataset.column;
            let next = ph.nextElementSibling;
            while (next && !next.classList.contains('task-card')) next = next.nextElementSibling;

            this.holdScrollSnap();
            document.body.classList.remove('is-dragging');
            document.querySelectorAll('.tasks-container.drag-over').forEach(z => z.classList.remove('drag-over'));

            // moveTask re-renders the board; the ghost is exactly over the new card, so
            // removing it in the same frame is seamless
            const taskId = ph.dataset.taskId;
            const changed = this.moveTask(taskId, column, next ? next.dataset.taskId : null);
            if (changed) {
                const el = document.querySelector(`.task-card[data-task-id="${CSS.escape(taskId)}"]`);
                if (el) {
                    el.classList.add('just-dropped');
                    el.addEventListener('animationend', () => el.classList.remove('just-dropped'), { once: true });
                }
            } else {
                ph.classList.remove('is-placeholder');
            }
            d.ghost.remove();
            this.drag = null;
        });
    }

    // Scroll-snap would nudge a lane sideways the moment a drag ends (a small visible jump),
    // so it stays off until the person scrolls again.
    holdScrollSnap() {
        document.body.classList.add('snap-off');
        if (this._snapRelease) return;
        const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
        this._snapRelease = () => {
            if (this.drag) return;
            document.body.classList.remove('snap-off');
            events.forEach(t => window.removeEventListener(t, this._snapRelease));
            this._snapRelease = null;
        };
        events.forEach(t => window.addEventListener(t, this._snapRelease, { passive: true }));
    }

    // Escape, window blur or pointercancel: put the card back where it started
    abortDrag() {
        const d = this.drag;
        if (!d) return;
        this.teardownDragListeners();
        if (!d.active) { this.drag = null; return; }

        d.ending = true;
        cancelAnimationFrame(d.raf);
        const isStage = d.kind === 'stage';
        const ph = d.card, { parent, next } = d.origin;
        if (ph.parentNode !== parent || ph.nextElementSibling !== next) {
            this.flipMove(() => parent.insertBefore(ph, next), isStage ? null : ph);
            if (!isStage) this.setDragOver(parent);
        }
        this.landGhost(() => {
            this.holdScrollSnap();
            document.body.classList.remove('is-dragging', 'is-dragging-stage');
            document.querySelectorAll('.tasks-container.drag-over').forEach(z => z.classList.remove('drag-over'));
            ph.classList.remove('is-placeholder', 'is-placeholder-lane');
            d.ghost.remove();
            this.drag = null;
        });
    }

    // Utilities
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `toast show ${type}`;
        
        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }

    closeAllModals() {
        const wpModal = document.getElementById('wallpaper-modal');
        if (wpModal && wpModal.classList.contains('show')) {
            this.closeWallpaperModal();
        }
        document.querySelectorAll('.modal').forEach(modal => {
            modal.classList.remove('show');
        });
    }
    
    // Custom Dialog System to replace browser prompts/confirms
    showInputDialog(title, message, defaultValue = '', callback) {
        let dialog = document.getElementById('input-dialog');
        if (!dialog) {
            dialog = document.createElement('div');
            dialog.id = 'input-dialog';
            dialog.className = 'modal';
            dialog.innerHTML = `
                <div class="modal-content modal-small">
                    <div class="modal-header">
                        <h2 class="modal-title" id="input-dialog-title"></h2>
                        <button class="modal-close" onclick="kanban.closeInputDialog()">×</button>
                    </div>
                    <div class="modal-body">
                        <p id="input-dialog-message"></p>
                        <input type="text" class="form-input" id="input-dialog-input" maxlength="100">
                    </div>
                    <div class="modal-actions">
                        <button type="button" class="btn btn-secondary" onclick="kanban.closeInputDialog()">Cancel</button>
                        <button type="button" class="btn" onclick="kanban.submitInputDialog()">OK</button>
                    </div>
                </div>
            `;
            document.body.appendChild(dialog);
        }
        
        document.getElementById('input-dialog-title').textContent = title;
        document.getElementById('input-dialog-message').textContent = message;
        const input = document.getElementById('input-dialog-input');
        input.value = defaultValue;
        
        this.inputDialogCallback = callback;
        dialog.classList.add('show');
        
        // Focus and select input
        setTimeout(() => {
            input.focus();
            input.select();
        }, 100);
        
        // Handle enter key
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                this.submitInputDialog();
            }
        };
    }
    
    closeInputDialog() {
        const dialog = document.getElementById('input-dialog');
        if (dialog) {
            dialog.classList.remove('show');
            this.inputDialogCallback = null;
        }
    }
    
    submitInputDialog() {
        const value = document.getElementById('input-dialog-input').value;
        if (this.inputDialogCallback) {
            this.inputDialogCallback(value);
        }
        this.closeInputDialog();
    }
    
    showConfirmDialog(title, message, callback) {
        let dialog = document.getElementById('confirm-dialog');
        if (!dialog) {
            dialog = document.createElement('div');
            dialog.id = 'confirm-dialog';
            dialog.className = 'modal';
            dialog.innerHTML = `
                <div class="modal-content modal-small">
                    <div class="modal-header">
                        <h2 class="modal-title" id="confirm-dialog-title"></h2>
                        <button class="modal-close" onclick="kanban.closeConfirmDialog()">×</button>
                    </div>
                    <div class="modal-body">
                        <p id="confirm-dialog-message" style="white-space:pre-line"></p>
                    </div>
                    <div class="modal-actions">
                        <button type="button" class="btn btn-secondary" onclick="kanban.closeConfirmDialog()">Cancel</button>
                        <button type="button" class="btn btn-danger" onclick="kanban.submitConfirmDialog()">Confirm</button>
                    </div>
                </div>
            `;
            dialog.addEventListener('click', (e) => {
                if (e.target === dialog) this.closeConfirmDialog();
            });
            document.body.appendChild(dialog);
        }
        
        document.getElementById('confirm-dialog-title').textContent = title;
        document.getElementById('confirm-dialog-message').textContent = message;
        
        this.confirmDialogCallback = callback;
        dialog.classList.add('show');
    }
    
    closeConfirmDialog() {
        const dialog = document.getElementById('confirm-dialog');
        if (dialog) {
            dialog.classList.remove('show');
            this.confirmDialogCallback = null;
        }
    }
    
    submitConfirmDialog() {
        const cb = this.confirmDialogCallback;
        this.closeConfirmDialog();
        if (cb) {
            cb(true);
        }
    }
    
    // Color Selection Functions
    selectTaskColor(color) {
        document.getElementById('task-color').value = color;
        this.updateColorPickerSelection(color);
    }
    
    updateColorPickerSelection(color) {
        const container = document.querySelector('#task-modal .color-picker-container');
        if (!container) return;
        
        container.querySelectorAll('.color-option').forEach(btn => {
            btn.classList.remove('selected');
            if (btn.dataset.color === color) {
                btn.classList.add('selected');
            }
        });
    }
    
    openCustomColorPicker() {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = document.getElementById('task-color').value || '#3b82f6';
        input.onchange = (e) => {
            this.selectTaskColor(e.target.value);
        };
        input.click();
    }

    // Column Color Selection Functions
    selectColumnColor(color) {
        document.getElementById('column-color').value = color;
        this.updateColumnColorPickerSelection(color);
    }

    updateColumnColorPickerSelection(color) {
        const container = document.querySelector('#column-modal .color-picker-container');
        if (!container) return;

        container.querySelectorAll('.color-option').forEach(btn => {
            btn.classList.remove('selected');
            if (btn.dataset.color === color) {
                btn.classList.add('selected');
            }
        });
    }

    openCustomColumnColorPicker() {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = document.getElementById('column-color').value || '#3b82f6';
        input.onchange = (e) => {
            this.selectColumnColor(e.target.value);
        };
        input.click();
    }
}

// Add pulse animation dynamically
const style = document.createElement('style');
style.textContent = `
    @keyframes pulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.05); }
    }
`;
document.head.appendChild(style);

