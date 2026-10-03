const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------------------------------------------------------
// 1. Biztonsagi fejlecek es alapertelmezett vedelmek (Security Headers)
// ----------------------------------------------------------------------
app.disable('x-powered-by');

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// JSON request body parser meretkorlattal (DoS megelozes)
app.use(express.json({ limit: '100kb' }));

// ----------------------------------------------------------------------
// 2. Biztonsagos Session beallitasok
// ----------------------------------------------------------------------
const isProd = process.env.NODE_ENV === 'production';
app.use(session({
    name: '__Host_sid', // Erinthetetlen cookie prefix ha HTTPS, egyebkent biztonsagos nev
    secret: process.env.SESSION_SECRET || 'erettsegi-secret-key-31415-node-hardened',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'strict',
        secure: isProd,
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 nap
    }
}));

// ----------------------------------------------------------------------
// 3. Fajlelresi utak
// ----------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks_data.json');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const LESSONS_FILE = path.join(DATA_DIR, 'task_lessons.json');

// ----------------------------------------------------------------------
// 4. Hitelesites & Jelszokezeles (Scrypt kriptografiai hashekkel)
// ----------------------------------------------------------------------
const USERS = {
    'admin31415': {
        role: 'admin',
        salt: '385f9cc3fc0f8dd1b31a1b15e4d38522',
        hash: '4fb8f86520f940d6273cd5d0ca4bec5f08972fa68d8ad677ebf9193e6c7875ffb2170c011b3d815fe4ee9c59aac7750378d0bfcecde4c3e28e0450ff91317ec1'
    },
    'diak31415': {
        role: 'student',
        salt: '2464e854b0298be257aea9a3f1735b2d',
        hash: '591ab857f6af64f187690398bc1c441c5395f82c5964ed252c2926bf296f6cac7c110df0df2b5d6eeda823ebbf0179fe2aaf8034bc9b517a5040e83023e94596'
    }
};

function verifyUserPassword(username, password) {
    if (!username || !password || typeof password !== 'string') return null;
    const user = USERS[username];
    if (!user) return null;

    try {
        const computed = crypto.scryptSync(password, user.salt, 64);
        const stored = Buffer.from(user.hash, 'hex');
        if (computed.length === stored.length && crypto.timingSafeEqual(computed, stored)) {
            return user;
        }
    } catch (e) {
        return null;
    }
    return null;
}

// ----------------------------------------------------------------------
// 5. Rate Limiter (Brute force vedelmi mechanizmus a bejelentkezeshez)
// ----------------------------------------------------------------------
const loginAttempts = new Map(); // ip -> { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 perc

function checkRateLimit(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry) return { allowed: true };

    if (entry.lockedUntil && entry.lockedUntil > now) {
        const remainingSec = Math.ceil((entry.lockedUntil - now) / 1000);
        return { allowed: false, remainingSec };
    }

    if (entry.lockedUntil && entry.lockedUntil <= now) {
        loginAttempts.delete(ip);
        return { allowed: true };
    }

    return { allowed: true };
}

function recordFailedAttempt(ip) {
    const now = Date.now();
    let entry = loginAttempts.get(ip) || { count: 0 };
    entry.count += 1;
    if (entry.count >= MAX_ATTEMPTS) {
        entry.lockedUntil = now + LOCKOUT_MS;
    }
    loginAttempts.set(ip, entry);
}

function clearAttempts(ip) {
    loginAttempts.delete(ip);
}

// Lejart bejegyzesek takaritasa orankent
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of loginAttempts.entries()) {
        if (entry.lockedUntil && entry.lockedUntil <= now) {
            loginAttempts.delete(ip);
        }
    }
}, 60 * 60 * 1000).unref();

// ----------------------------------------------------------------------
// 6. Segedfuggvenyek a jogosultsagok es bemenetek ellenorzesehez
// ----------------------------------------------------------------------
function isSessionValid(req) {
    return req.session && (req.session.is_admin === true || req.session.is_student === true);
}

function isAdmin(req) {
    return req.session && req.session.is_admin === true;
}

// Szigoruan engedelyezett taskId es input szures (Prototype pollution elleni vedelem)
const SAFE_ID_REGEX = /^[A-Za-z0-9_-]{1,32}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isValidTaskId(id) {
    return typeof id === 'string' && SAFE_ID_REGEX.test(id) && !DANGEROUS_KEYS.has(id);
}

// ----------------------------------------------------------------------
// 7. Statikus fajlok kiszolgalasa (Kizarolag a publikus assetek!)
// ----------------------------------------------------------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/style.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'style.css'));
});
app.get('/app.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'app.js'));
});

// A data mappa es egyeb forraskodok kozvetlen elerese tilos
app.use('/data', (req, res) => {
    res.status(403).json({ error: 'Access Denied' });
});

// ----------------------------------------------------------------------
// 8. POST /api/login - Vedett bejelentkezes
// ----------------------------------------------------------------------
app.post('/api/login', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const rateCheck = checkRateLimit(ip);
    if (!rateCheck.allowed) {
        return res.status(429).json({
            success: false,
            message: `Túl sok sikertelen kísérlet! Kérjük próbáld újra ${rateCheck.remainingSec} másodperc múlva.`
        });
    }

    const { username, password } = req.body || {};
    const user = verifyUserPassword(username, password);

    if (user) {
        clearAttempts(ip);

        // Session Fixation vedelme: uj session generalasa sikeres login eseten
        req.session.regenerate((err) => {
            if (err) {
                return res.status(500).json({ error: 'Hiba a munkamenet inicializálásakor' });
            }
            req.session.is_admin = (user.role === 'admin');
            req.session.is_student = (user.role === 'student');
            req.session.username = username;
            return res.json({ success: true });
        });
    } else {
        recordFailedAttempt(ip);
        return res.status(401).json({ success: false, message: 'Helytelen felhasználónév vagy jelszó!' });
    }
});

// ----------------------------------------------------------------------
// 9. POST /api/logout
// ----------------------------------------------------------------------
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Kijelentkezési hiba' });
        }
        res.clearCookie('__Host_sid');
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

// ----------------------------------------------------------------------
// 10. GET /api/tasks - Feladatok lekerese (Adatmaszkolas vendegkent)
// ----------------------------------------------------------------------
app.get('/api/tasks', (req, res) => {
    if (!fs.existsSync(TASKS_FILE)) {
        return res.status(500).json({ error: 'Adatbázis hiba' });
    }

    try {
        const tasksData = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
        const loggedIn = isSessionValid(req);

        if (loggedIn) {
            // Bejelentkezett felhasznalo minden adatot megkap
            const unlockedTasks = tasksData.map(task => ({
                ...task,
                isLocked: false
            }));
            const role = req.session.is_admin ? 'admin' : 'student';
            return res.json({ isLoggedIn: true, role: role, tasks: unlockedTasks });
        }

        // Vendeg eseten biztonsagi adatmaszkolas: 3. index felett minden megoldast eltavolitva kizarolag cim/kategoria megy le
        const categoryCounts = {};
        const maskedTasks = [];

        for (const task of tasksData) {
            const cat = task.category;
            if (!categoryCounts[cat]) {
                categoryCounts[cat] = 0;
            }

            const index = categoryCounts[cat];
            categoryCounts[cat]++;

            if (index >= 3) {
                maskedTasks.push({
                    id: task.id,
                    category: task.category,
                    categoryName: task.categoryName,
                    title: task.title,
                    isLocked: true
                });
            } else {
                maskedTasks.push({
                    ...task,
                    isLocked: false
                });
            }
        }

        res.json({ isLoggedIn: false, tasks: maskedTasks });
    } catch (err) {
        res.status(500).json({ error: 'Adatfeldolgozási hiba' });
    }
});

// ----------------------------------------------------------------------
// 11. GET & POST /api/status - Statuszkezeles (Input szanitizacio)
// ----------------------------------------------------------------------
app.get('/api/status', (req, res) => {
    if (!isSessionValid(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const username = req.session.username || 'unknown';
    if (fs.existsSync(STATUS_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
            let allStatuses = {};
            const keys = Object.keys(raw);
            const isOldFormat = keys.some(key => key.startsWith('S'));
            if (isOldFormat) {
                allStatuses = {
                    'admin31415': raw
                };
            } else {
                allStatuses = raw;
            }
            const userStatuses = allStatuses[username] || {};
            res.json(userStatuses);
        } catch (e) {
            res.json({});
        }
    } else {
        res.json({});
    }
});

const ALLOWED_STATUSES = new Set(['kesz', 'atnezendo', 'default']);

app.post('/api/status', (req, res) => {
    if (!isSessionValid(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const { taskId, status } = req.body || {};

    // Szigoru bemenet-ellenorzes
    if (!isValidTaskId(taskId)) {
        return res.status(400).json({ error: 'Érvénytelen feladat azonosító' });
    }
    if (!ALLOWED_STATUSES.has(status)) {
        return res.status(400).json({ error: 'Érvénytelen státusz' });
    }

    const username = req.session.username;
    if (!username || DANGEROUS_KEYS.has(username)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    let allStatuses = {};
    if (fs.existsSync(STATUS_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
            const keys = Object.keys(raw);
            const isOldFormat = keys.some(key => key.startsWith('S'));
            if (isOldFormat) {
                allStatuses = { 'admin31415': raw };
            } else {
                allStatuses = raw;
            }
        } catch (e) {
            allStatuses = {};
        }
    }

    if (!allStatuses[username]) {
        allStatuses[username] = {};
    }

    if (status === 'default') {
        delete allStatuses[username][taskId];
    } else {
        allStatuses[username][taskId] = status;
    }

    try {
        fs.writeFileSync(STATUS_FILE, JSON.stringify(allStatuses, null, 2), 'utf8');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Mentési hiba' });
    }
});

// ----------------------------------------------------------------------
// 12. GET & POST /api/lessons - Orak hozzarendelese (Kizarolag Admin)
// ----------------------------------------------------------------------
app.get('/api/lessons', (req, res) => {
    if (fs.existsSync(LESSONS_FILE)) {
        res.sendFile(LESSONS_FILE);
    } else {
        res.json({});
    }
});

app.post('/api/lessons', (req, res) => {
    if (!isAdmin(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const { taskId, lesson } = req.body || {};

    if (!isValidTaskId(taskId)) {
        return res.status(400).json({ error: 'Érvénytelen feladat azonosító' });
    }

    let lessonsData = {};
    if (fs.existsSync(LESSONS_FILE)) {
        try {
            lessonsData = JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf8'));
        } catch (e) {
            lessonsData = {};
        }
    }

    if (lesson === null || lesson === '') {
        delete lessonsData[taskId];
    } else {
        const lessonNum = parseInt(lesson, 10);
        if (isNaN(lessonNum) || lessonNum < 1 || lessonNum > 20) {
            return res.status(400).json({ error: 'Érvénytelen óraszám (1-20)' });
        }
        lessonsData[taskId] = lessonNum;
    }

    try {
        fs.writeFileSync(LESSONS_FILE, JSON.stringify(lessonsData, null, 2), 'utf8');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Mentési hiba' });
    }
});

// Ismeretlen utvonalak kezelese
app.use((req, res) => {
    res.status(404).json({ error: 'Nem található' });
});

// Inditas
app.listen(PORT, () => {
    console.log(`Local development Node server running securely on http://localhost:${PORT}`);
});
