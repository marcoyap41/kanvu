const { boot, ok, wait, summary } = require('./harness');
const { createServer } = require('../mock-server/server.js');

const listen = (srv) => new Promise(r => srv.listen(0, () => r(srv.address().port)));
const $ = (w, sel) => w.document.querySelector(sel);
const fill = (w, id, v) => { $(w, '#' + id).value = v; };
const askButtons = (w) => [...w.document.querySelectorAll('#account-ask.show #account-ask-buttons button')];

(async () => {
  const srv = createServer({ frontendUrl: 'http://localhost' });
  const port = await listen(srv);
  const api = `http://localhost:${port}`;
  const jar = { cookies: {} };

  console.log('Signed-out draft (backend configured, never signed in)');
  let r = await boot({}, { apiUrl: api, jar });
  let { w, k, errors, ls } = r;
  ok(errors.length === 0, 'no errors ' + errors.slice(0, 2).join('|'));
  ok(k.storage.mode === 'draft', 'starts as a draft');
  ok(jar.calls === undefined, 'no server calls when signed out');
  ok($(w, '#account-button').textContent === 'Sign in', 'button says Sign in');
  ok($(w, '#draft-banner').hidden === false, 'not-saved banner is visible');
  ok($(w, '#save-button').textContent === 'Sign in to save' && !$(w, '#save-button').disabled, 'Save button asks to sign in');
  ok($(w, '#autosave-button').disabled === true, 'autosave switch is disabled');
  k.tasks.push({ id: 'g1', title: 'draft task', column: 'todo' });
  k.commit(); await wait(50);
  const guestBoardId = k.currentBoardId;
  ok(ls.getItem('kanban-saved-boards') === null, 'no board is written to localStorage');
  ok(JSON.parse(w.sessionStorage.getItem('kanban-saved-boards'))[guestBoardId].tasks.length === 1, 'draft is kept in sessionStorage');
  $(w, '#save-button').click();
  ok($(w, '#auth-modal').classList.contains('show'), 'Save opens the sign-in dialog');
  ok(/not saved yet/.test($(w, '#auth-note').textContent), 'dialog explains nothing was saved');
  w.eval('account.closeModal()');
  w.eval('kanban.toggleAutosave()');
  ok(!!$(w, '#auth-modal.show') && k.autosaveEnabled === false, 'autosave toggle also asks to sign in');
  w.eval('account.closeModal()');
  const reloaded = await boot({}, { apiUrl: api, jar, sessionSeed: { 'kanban-saved-boards': w.sessionStorage.getItem('kanban-saved-boards'), 'kanban-current-board-id': guestBoardId } });
  ok(reloaded.k.storage.mode === 'draft' && reloaded.k.tasks.some(t => t.id === 'g1'), 'a reload in the same tab keeps the draft');

  console.log('Register through the dialog');
  $(w, '#account-button').click();
  ok($(w, '#auth-modal').classList.contains('show'), 'dialog opens');
  w.eval('account.setAuthMode("register")');
  fill(w, 'auth-email', 'liang@example.com'); fill(w, 'auth-password', 'short');
  await w.eval('account.submit()');
  ok(!$(w, '#auth-error').hidden && /8 characters/.test($(w, '#auth-error').textContent), 'short password rejected in the browser');
  fill(w, 'auth-password', 'longenough1');
  const submitting = w.eval('account.submit()');
  await wait(300);
  const btns = askButtons(w);
  ok(btns.length === 2 && /Add to my account/.test(btns[0].textContent), 'import offer shown with add or discard');
  btns[0].click();
  await submitting; await wait(300);
  ok(k.storage.mode === 'account', 'now in account mode');
  ok($(w, '#account-button').textContent === 'L', 'button shows initial');
  ok(Object.values(k.savedBoards).some(b => b.name === 'Untitled Board' && b.tasks.some(t => t.id === 'g1')), 'guest board imported and loaded from server');
  ok(/^[0-9a-f-]{36}$/.test(k.currentBoardId), 'account board uses a UUID');
  ok(w.sessionStorage.getItem('kanban-saved-boards') === null, 'draft is cleared after the import');
  ok($(w, '#draft-banner').hidden === true, 'banner hidden once signed in');
  ok($(w, '#save-button').textContent !== 'Sign in to save' && $(w, '#autosave-button').disabled === false, 'Save and autosave work again');

  console.log('Edit + board operations in account mode');
  k.tasks.push({ id: 'a1', title: 'account task', column: 'todo' });
  ok(await k.saveCurrentBoard() === true, 'save resolves true');
  const get = async () => (await w.fetch(api + '/boards', { headers: { Authorization: 'Bearer ' + w.eval('auth.accessToken') } })).json();
  let srvData = await get();
  ok(srvData.boards[0].tasks.some(t => t.id === 'a1'), 'task saved on the server');
  ok(k.isSaved(), 'marked saved');
  const firstId = k.currentBoardId;
  k.showInputDialog = (t, m, d, cb) => cb('Work'); k.createNewBoard(); await wait(200);
  srvData = await get();
  ok(srvData.boards.length === 2 && srvData.boards.some(b => b.name === 'Work'), 'new board on the server');
  const workId = k.currentBoardId;
  k.moveBoard(workId, -1); await wait(150);
  ok((await get()).order[0] === workId, 'order saved on the server');
  k.showConfirmDialog = (t, m, cb) => cb(true);
  k.deleteBoard(workId); await wait(200);
  srvData = await get();
  ok(srvData.trash.some(b => b.id === workId) && srvData.boards.length === 1, 'board in server trash');
  ok(k.currentBoardId === firstId, 'fell back to the other board');
  await k.restoreBoard(workId); await wait(150);
  ok((await get()).boards.length === 2 && k.savedBoards[workId], 'restored');
  k.deleteBoard(workId); await wait(200); k.deleteBoardForever(workId); await wait(150);
  srvData = await get();
  ok(srvData.trash.length === 0, 'purged from the server');

  console.log('Sign out leaves an empty draft');
  k.tasks.push({ id: 'a2', title: 'unsaved', column: 'todo' });
  w.eval('account.signOut()'); await wait(300);
  ok(k.storage.mode === 'draft', 'back to a draft');
  ok(srvData && (await (await fetch(api + '/boards')).status) === 401, 'server rejects without token');
  ok(Object.keys(k.savedBoards).length === 1 && k.tasks.length === 0, 'shows an empty draft, not the account boards');
  ok(!JSON.stringify(Object.values(k.savedBoards)).includes('a1') && !(w.sessionStorage.getItem('kanban-saved-boards') || '').includes('account task'), 'no account data left in the browser');
  ok($(w, '#draft-banner').hidden === false, 'banner is back');
  ok($(w, '#account-button').textContent === 'Sign in', 'button back to Sign in');

  console.log('Wrong password');
  $(w, '#account-button').click();
  fill(w, 'auth-email', 'liang@example.com'); fill(w, 'auth-password', 'wrongpass1');
  await w.eval('account.submit()');
  ok(/Invalid email or password/.test($(w, '#auth-error').textContent), 'server error shown in dialog');
  fill(w, 'auth-password', 'longenough1');
  await w.eval('account.submit()'); await wait(300);
  ok(k.storage.mode === 'account', 'login works');
  ok(!askButtons(w).length, 'no import offer when the draft is empty');
  ok(Object.values(k.savedBoards).some(b => b.tasks.some(t => t.id === 'a1')), 'account boards loaded again');

  console.log('Reload while signed in');
  const seed = {}; for (let i = 0; i < ls.length; i++) seed[ls.key(i)] = ls.getItem(ls.key(i));
  r = await boot(seed, { apiUrl: api, jar });
  ok(r.errors.length === 0, 'no errors on reload ' + r.errors.slice(0, 2).join('|'));
  ok(r.k.storage.mode === 'account', 'reload starts straight in account mode');
  ok(Object.values(r.k.savedBoards).some(b => b.tasks.some(t => t.id === 'a1')), 'account data loaded without guest flash');

  console.log('Expired access token refreshes silently');
  const tok = r.w.eval('auth.accessToken'); r.w.eval('auth.accessToken = "stale"');
  r.k.tasks.push({ id: 'a3', title: 'after refresh', column: 'todo' });
  ok(await r.k.saveCurrentBoard() === true && r.w.eval('auth.accessToken') !== 'stale', 'save succeeded after transparent refresh');

  console.log('Session lost');
  jar.cookies = {}; r.w.eval('auth.accessToken = "stale"');
  r.k.tasks.push({ id: 'a4', title: 'will fail', column: 'todo' });
  const okSave = await r.k.saveCurrentBoard();
  ok(okSave === false, 'save fails when the session is gone');
  ok(!r.k.isSaved(), 'board stays marked unsaved');
  ok(r.w.document.querySelector('#auth-modal.show'), 'sign-in dialog shown');
  ok(r.k.storage.mode === 'account', 'still in account mode (edits not thrown away)');
  r.w.eval('account.setAuthMode("login")');
  fill(r.w, 'auth-email', 'liang@example.com'); fill(r.w, 'auth-password', 'longenough1');
  await r.w.eval('account.submit()'); await wait(200);
  ok(await r.k.saveCurrentBoard() === true && r.k.isSaved(), 'after signing in again the edit saves');

  console.log('OAuth return');
  const jar2 = { cookies: {} };
  await makeCookie(api, jar2, '/auth/github');
  const o = await boot({ 'kanban-session': '' }, { apiUrl: api, jar: jar2, url: 'http://localhost/#auth=success' });
  ok(o.k.storage.mode === 'account' && o.w.eval('auth.user.email') === 'github-user@example.com', 'redirect with #auth=success opens account mode');
  ok(!o.w.location.hash, 'hash removed from the URL');

  console.log('OAuth return keeps the draft and offers to add it');
  const jar3 = { cookies: {} };
  await makeCookie(api, jar3, '/auth/google');
  const draftBoard = { 'b1': { id: 'b1', name: 'Made before signing in', tasks: [{ id: 'x1', title: 'draft card', column: 'todo' }], columns: [{ id: 'todo', title: 'To Do', order: 0 }], lastModified: new Date().toISOString(), createdAt: new Date().toISOString() } };
  const ob = await boot({}, { apiUrl: api, jar: jar3, url: 'http://localhost/#auth=success', sessionSeed: { 'kanban-saved-boards': JSON.stringify(draftBoard), 'kanban-current-board-id': 'b1' } });
  await wait(400);
  const obBtns = askButtons(ob.w);
  ok(ob.k.storage.mode === 'account' && obBtns.length === 2, 'account mode with the import offer');
  obBtns[0].click(); await wait(500);
  const obBoards = await (await ob.w.fetch(api + '/boards', { headers: { Authorization: 'Bearer ' + ob.w.eval('auth.accessToken') } })).json();
  ok(obBoards.boards.some(b => b.name === 'Made before signing in' && b.tasks.length === 1), 'draft board added to the account');
  ok(ob.w.sessionStorage.getItem('kanban-saved-boards') === null, 'draft cleared afterwards');

  console.log('Discard on sign in');
  const jar4 = { cookies: {} };
  await makeCookie(api, jar4, '/auth/github');
  const od = await boot({}, { apiUrl: api, jar: jar4, url: 'http://localhost/#auth=success', sessionSeed: { 'kanban-saved-boards': JSON.stringify(draftBoard), 'kanban-current-board-id': 'b1' } });
  await wait(400);
  askButtons(od.w)[1].click(); await wait(300);
  const odBoards = await (await od.w.fetch(api + '/boards', { headers: { Authorization: 'Bearer ' + od.w.eval('auth.accessToken') } })).json();
  ok(!odBoards.boards.some(b => b.name === 'Made before signing in'), 'discarded draft is not added');
  ok(od.w.sessionStorage.getItem('kanban-saved-boards') === null, 'draft cleared after discard');

  console.log('Server down at startup');
  const seed2 = { 'kanban-session': '1' };
  const d = await boot(seed2, { apiUrl: 'http://localhost:1', jar: { cookies: {} } });
  await wait(100);
  ok(Object.keys(d.k.savedBoards).length === 0 && d.w.document.querySelector('.board').children.length === 0, 'does not show an empty board when the server is down');
  ok(!!d.w.document.querySelector('#startup-overlay:not([hidden])') && /Cannot reach the server/.test(d.w.document.getElementById('startup-overlay').textContent), 'shows the server error screen with retry');
  ok(d.errors.length === 0, 'no uncaught errors ' + d.errors.slice(0, 2).join('|'));

  console.log('Backend not configured');
  const n = await boot({}, {});
  ok($(n.w, '#account-wrap').hidden === true, 'account button hidden when apiUrl is empty');
  ok(n.k.storage.mode === 'guest' && !n.k.isDraft(), 'keeps the old localStorage behavior (development)');
  ok($(n.w, '#draft-banner').hidden === true, 'no banner without a backend');

  srv.close();
  summary();
})().catch(e => { console.error(e); process.exit(1); });

async function makeCookie(api, jar, path) {
  const res = await fetch(api + path, { redirect: 'manual' });
  (res.headers.getSetCookie() || []).forEach(sc => { const [kv] = sc.split(';'); const i = kv.indexOf('='); jar.cookies[kv.slice(0, i)] = kv.slice(i + 1); });
}
