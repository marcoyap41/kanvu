/**
 * Kanvu mock server: a tiny in-memory stand-in for your NestJS backend (no dependencies).
 * It implements docs/API_CONTRACT.md so you can run and test the frontend before the real backend exists,
 * and it doubles as a reference for what each route must return.
 *
 *   node mock-server/server.js            -> http://localhost:3000
 *   set apiUrl: 'http://localhost:3000' in config.js, then serve the frontend (e.g. npx serve .)
 *
 * Everything is lost when the process stops. Not for production: passwords are stored in plain text.
 */
const http = require('http');
const crypto = require('crypto');

function createServer({ frontendUrl = 'http://localhost:5173', accessTtlMs = 15 * 60 * 1000 } = {}) {
    const users = new Map();           // id -> { id, email, name, password }
    const refreshTokens = new Map();   // token -> userId
    const accessTokens = new Map();    // token -> { userId, expires }
    const boards = new Map();          // userId -> Map(boardId -> { board, deletedAt })
    const orders = new Map();          // userId -> [boardId]

    const uid = () => crypto.randomUUID();
    const userBoards = (u) => { if (!boards.has(u)) boards.set(u, new Map()); return boards.get(u); };
    const userOrder = (u) => { if (!orders.has(u)) orders.set(u, []); return orders.get(u); };

    class HttpError extends Error {
        constructor(status, message) { super(message); this.status = status; }
    }

    const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name || null });

    function issueTokens(res, user) {
        const accessToken = crypto.randomBytes(24).toString('hex');
        accessTokens.set(accessToken, { userId: user.id, expires: Date.now() + accessTtlMs });
        const refresh = crypto.randomBytes(24).toString('hex');
        refreshTokens.set(refresh, user.id);
        // Real backend: add "Secure; SameSite=None" when the frontend and API are on different sites (production)
        res.setHeader('Set-Cookie', `kanvu_rt=${refresh}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
        return { accessToken, user: publicUser(user) };
    }

    function authUser(req) {
        const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        const t = m && accessTokens.get(m[1]);
        if (!t || t.expires < Date.now()) throw new HttpError(401, 'Unauthorized');
        return t.userId;
    }

    function cookie(req, name) {
        const m = new RegExp('(?:^|; )' + name + '=([^;]*)').exec(req.headers.cookie || '');
        return m ? m[1] : null;
    }

    function validateBoard(b) {
        const problems = [];
        if (!b || typeof b !== 'object') problems.push('body must be a board object');
        else {
            if (typeof b.name !== 'string' || !b.name.trim()) problems.push('name must be a non-empty string');
            if (!Array.isArray(b.tasks)) problems.push('tasks must be an array');
            if (!Array.isArray(b.columns)) problems.push('columns must be an array');
        }
        if (problems.length) throw new HttpError(400, problems.join(', '));
    }

    function upsert(userId, id, body) {
        validateBoard(body);
        const map = userBoards(userId);
        const existing = map.get(id);
        const now = new Date().toISOString();
        const board = { id, name: body.name, tasks: body.tasks, columns: body.columns, createdAt: existing ? existing.board.createdAt : now, lastModified: now };
        map.set(id, { board, deletedAt: existing ? existing.deletedAt : null });
        const order = userOrder(userId);
        if (!existing) order.push(id);
        return map.get(id);
    }

    const route = {
        'POST /auth/register'(req, res, body) {
            const { email, password, name } = body || {};
            const problems = [];
            if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email)) problems.push('email must be an email');
            if (typeof password !== 'string' || password.length < 8) problems.push('password must be longer than or equal to 8 characters');
            if (problems.length) throw new HttpError(400, problems.join(', '));
            if ([...users.values()].some(u => u.email === email.toLowerCase())) throw new HttpError(409, 'Email already registered');
            const user = { id: uid(), email: email.toLowerCase(), name: name || null, password };
            users.set(user.id, user);
            return [201, issueTokens(res, user)];
        },
        'POST /auth/login'(req, res, body) {
            const user = [...users.values()].find(u => u.email === String((body || {}).email || '').toLowerCase());
            if (!user || user.password !== (body || {}).password) throw new HttpError(401, 'Invalid email or password');
            return [200, issueTokens(res, user)];
        },
        'POST /auth/refresh'(req, res) {
            const old = cookie(req, 'kanvu_rt');
            const userId = old && refreshTokens.get(old);
            if (!userId) throw new HttpError(401, 'Invalid refresh token');
            refreshTokens.delete(old); // rotation: each refresh token works once
            return [200, issueTokens(res, users.get(userId))];
        },
        'POST /auth/logout'(req, res) {
            refreshTokens.delete(cookie(req, 'kanvu_rt'));
            res.setHeader('Set-Cookie', 'kanvu_rt=; HttpOnly; Path=/; Max-Age=0');
            return [204];
        },
        'GET /boards'(req) {
            const u = authUser(req), map = userBoards(u);
            const order = userOrder(u).filter(id => map.has(id) && !map.get(id).deletedAt);
            return [200, {
                boards: order.map(id => map.get(id).board),
                order,
                trash: [...map.values()].filter(e => e.deletedAt).map(e => ({ ...e.board, deletedAt: e.deletedAt }))
            }];
        },
        'PUT /board-order'(req, res, body) {
            const u = authUser(req), map = userBoards(u);
            if (!body || !Array.isArray(body.ids)) throw new HttpError(400, 'ids must be an array');
            orders.set(u, body.ids.filter(id => map.has(id) && !map.get(id).deletedAt));
            return [204];
        },
        'POST /boards/import'(req, res, body) {
            const u = authUser(req);
            if (!body || !Array.isArray(body.boards)) throw new HttpError(400, 'boards must be an array');
            const idMap = {}, created = [];
            for (const b of body.boards) {
                const id = uid();
                idMap[b.id] = id;
                const e = upsert(u, id, b);
                if (b.createdAt) e.board.createdAt = b.createdAt;
                created.push(e.board);
            }
            return [201, { idMap, boards: created }];
        },
        'DELETE /trash'(req) {
            const u = authUser(req), map = userBoards(u);
            for (const [id, e] of map) if (e.deletedAt) map.delete(id);
            return [204];
        },
    };

    function boardRoute(method, parts, req, body) {
        const u = authUser(req), map = userBoards(u);
        const id = decodeURIComponent(parts[1]);
        const entry = map.get(id);
        if (method === 'PUT' && parts.length === 2) {
            if (entry && entry.deletedAt) throw new HttpError(409, 'Board is in the trash');
            return [200, upsert(u, id, body).board];
        }
        if (method === 'POST' && parts[2] === 'trash') {
            let e = entry;
            if (body && Object.keys(body).length) e = upsert(u, id, body); // keep the latest content, then trash it
            if (!e) throw new HttpError(404, 'Board not found');
            e.deletedAt = new Date().toISOString();
            userOrder(u).splice(0, userOrder(u).length, ...userOrder(u).filter(x => x !== id));
            return [200, { ...e.board, deletedAt: e.deletedAt }];
        }
        if (method === 'POST' && parts[2] === 'restore') {
            if (!entry || !entry.deletedAt) throw new HttpError(404, 'Board not in the trash');
            entry.deletedAt = null;
            if (!userOrder(u).includes(id)) userOrder(u).push(id);
            return [200, entry.board];
        }
        if (method === 'DELETE' && parts.length === 2) {
            if (!entry) throw new HttpError(404, 'Board not found');
            if (!entry.deletedAt) throw new HttpError(409, 'Move the board to the trash first');
            map.delete(id);
            return [204];
        }
        throw new HttpError(404, 'Not found');
    }

    return http.createServer((req, res) => {
        const origin = req.headers.origin || frontendUrl;
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            try {
                const url = new URL(req.url, 'http://x');
                const parts = url.pathname.split('/').filter(Boolean);

                // OAuth stand-in: a real backend redirects to Google/GitHub, then to its callback, then here
                if (req.method === 'GET' && parts[0] === 'auth' && (parts[1] === 'google' || parts[1] === 'github')) {
                    const email = `${parts[1]}-user@example.com`;
                    let user = [...users.values()].find(u => u.email === email);
                    if (!user) { user = { id: uid(), email, name: parts[1], password: crypto.randomBytes(8).toString('hex') }; users.set(user.id, user); }
                    issueTokens(res, user);
                    res.writeHead(302, { Location: frontendUrl + '/#auth=success' });
                    return res.end();
                }

                let body;
                if (raw) { try { body = JSON.parse(raw); } catch (e) { throw new HttpError(400, 'Invalid JSON'); } }

                const handler = route[`${req.method} ${url.pathname}`];
                const result = handler
                    ? handler(req, res, body)
                    : (parts[0] === 'boards' && parts.length >= 2 ? boardRoute(req.method, parts, req, body) : (() => { throw new HttpError(404, 'Not found'); })());
                const [status, data] = result;
                if (data === undefined) { res.writeHead(status); return res.end(); }
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            } catch (e) {
                const status = e.status || 500;
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ statusCode: status, message: e.message, error: status === 400 ? 'Bad Request' : status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'Error' }));
                if (status === 500) console.error(e);
            }
        });
    });
}

module.exports = { createServer };

if (require.main === module) {
    const port = process.env.PORT || 3000;
    createServer({ frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173' }).listen(port, () => {
        console.log(`Kanvu mock API on http://localhost:${port}`);
    });
}
