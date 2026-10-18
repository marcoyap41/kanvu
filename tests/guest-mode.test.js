const { boot, ok, wait, summary } = require('./harness');
(async () => {
  console.log('Fresh start');
  let { w, k, errors, ls } = await boot();
  ok(errors.length === 0, 'no script errors on load ' + errors.slice(0,2).join('|'));
  ok(k.currentBoardId && Object.keys(k.savedBoards).length === 1, 'default board created');
  const boards = JSON.parse(ls.getItem('kanban-saved-boards'));
  ok(Object.keys(boards).length === 1, 'default board written to localStorage');
  ok(ls.getItem('kanban-current-board-id') === k.currentBoardId, 'current board id stored');

  console.log('Save edits');
  k.tasks.push({ id: 't1', title: 'Hello', column: 'todo' });
  ok(!k.isSaved(), 'edit marks unsaved');
  ok(await k.saveCurrentBoard() === true, 'saveCurrentBoard resolves true');
  ok(k.isSaved(), 'marked saved after save');
  ok(JSON.parse(ls.getItem('kanban-saved-boards'))[k.currentBoardId].tasks.length === 1, 'task persisted');

  console.log('Create board');
  const firstId = k.currentBoardId;
  k.tasks.push({ id: 't2', title: 'unsaved edit', column: 'todo' });
  k.showInputDialog = (t, m, d, cb) => cb('Second');
  k.createNewBoard(); await wait();
  ok(k.currentBoardName === 'Second' && k.currentBoardId !== firstId, 'new board is open');
  ok(ls.getItem('kanban-current-board-id') === k.currentBoardId, 'new board id remembered');
  const b2 = JSON.parse(ls.getItem('kanban-saved-boards'));
  ok(Object.keys(b2).length === 2, 'two boards stored');
  ok(b2[firstId].tasks.length === 2, 'unsaved edit of old board saved before switching');
  ok(w.document.getElementById('board-name').value === 'Second', 'title input shows new name');

  console.log('Switch + order');
  await k.performBoardSwitch(firstId);
  ok(k.currentBoardId === firstId && k.tasks.length === 2, 'switched back');
  const secondId = Object.keys(k.savedBoards).find(i => i !== firstId);
  k.moveBoard(secondId, -1); await wait();
  ok(JSON.parse(ls.getItem('kanban-board-order'))[0] === secondId, 'order persisted');
  ok(k.getOrderedBoardIds()[0] === secondId, 'order read from cache');

  console.log('Trash');
  k.showConfirmDialog = (t, m, cb) => cb(true);
  k.deleteBoard(secondId); await wait();
  ok(!k.savedBoards[secondId] && k.trash[secondId], 'moved to trash in memory');
  ok(!JSON.parse(ls.getItem('kanban-saved-boards'))[secondId], 'removed from stored boards');
  ok(JSON.parse(ls.getItem('kanban-trash-boards'))[secondId].deletedAt, 'trash entry has deletedAt');
  k.deleteBoard(firstId); await wait();
  ok(k.savedBoards[firstId], 'cannot delete last board');
  await k.restoreBoard(secondId); await wait();
  ok(k.savedBoards[secondId] && !k.trash[secondId], 'restored');
  ok(!JSON.parse(ls.getItem('kanban-trash-boards'))[secondId], 'trash cleared in storage');
  ok(!('deletedAt' in k.savedBoards[secondId]), 'deletedAt stripped');
  k.deleteBoard(secondId); await wait();
  k.deleteBoardForever(secondId); await wait();
  ok(Object.keys(k.trash).length === 0 && Object.keys(JSON.parse(ls.getItem('kanban-trash-boards'))).length === 0, 'delete forever');
  k.showInputDialog = (t, m, d, cb) => cb('Third'); k.createNewBoard(); await wait();
  const third = k.currentBoardId; await k.performBoardSwitch(firstId);
  k.deleteBoard(third); await wait(); k.emptyTrash(); await wait();
  ok(Object.keys(k.trash).length === 0, 'empty trash');

  console.log('Duplicate');
  k.showInputDialog = (t, m, d, cb) => cb('Copy'); k.duplicateCurrentBoard(); await wait();
  ok(Object.values(JSON.parse(ls.getItem('kanban-saved-boards'))).some(b => b.name === 'Copy'), 'duplicate stored');

  console.log('Reload keeps data');
  const seed = {}; for (let i = 0; i < ls.length; i++) seed[ls.key(i)] = ls.getItem(ls.key(i));
  const r = await boot(seed);
  ok(r.errors.length === 0, 'no errors on reload ' + r.errors.slice(0,2).join('|'));
  ok(r.k.currentBoardId === firstId && r.k.tasks.length === 2, 'reload opens same board with tasks');
  ok(Object.keys(r.k.savedBoards).length === 2, 'reload has both boards');

  console.log('Prefs');
  k.setTheme('white'); ok(ls.getItem('kanban-theme') === 'white', 'theme stored under same key');
  k.setAutosave(true); ok(ls.getItem('kanban-autosave') === 'true', 'autosave stored under same key');

  console.log('Cross-tab');
  const other = JSON.parse(ls.getItem('kanban-saved-boards'));
  other[firstId] = { ...other[firstId], tasks: [{ id: 'x', title: 'from other tab', column: 'todo' }], lastModified: new Date(Date.now() + 5000).toISOString() };
  ls.setItem('kanban-saved-boards', JSON.stringify(other));
  w.dispatchEvent(new w.StorageEvent('storage', { key: 'kanban-saved-boards', storageArea: ls }));
  await wait(400);
  ok(k.tasks.length === 1 && k.tasks[0].id === 'x', 'newer board from another tab adopted');

  console.log('Overlapping saves are serialized');
  k.tasks.push({ id: 'a', title: 'a', column: 'todo' });
  const p1 = k.saveCurrentBoard(); const p2 = k.saveCurrentBoard();
  ok(k._pendingSaves === 2, 'two pending'); await Promise.all([p1, p2]);
  ok(k._pendingSaves === 0 && k.isSaved(), 'queue drained');

  summary();
})().catch(e => { console.error(e); process.exit(1); });
