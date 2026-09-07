const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '20mb' }));

// --- Auth ---
const USERS = {
    'agangloff': 'Alina Gangloff', 'atschernig': 'Andre Tschernig',
    'cpropp': 'Carolin Propp', 'cdittert': 'Charlotte Dittert',
    'dzobel': 'Dominik Zobel', 'fbecker': 'Florian Becker',
    'faugustin': 'Fritz Augustin', 'gheinze': 'Gina Heinze',
    'hleja': 'Hendrik Leja', 'jheber': 'Jason Heber',
    'jweichold': 'Jessy Weichold', 'jaltendorf': 'Jenny Altendorf',
    'kwiehl': 'Katharina Wiehl', 'khobritz': 'Kevin Hobritz',
    'kherbst': 'Konsti Herbst', 'lbrückner': 'Leon Brückner',
    'lschnell': 'Leon Schnell', 'lvoigt': 'Leopold Voigt',
    'lvogel': 'Lisa Vogel', 'lgröbel': 'Linda Gröbel',
    'lfucke': 'Lucas Fucke', 'lschulz': 'Lucas Schulz',
    'lmähler': 'Lukas Mähler', 'mmichaelis': 'Marcus Michaelis',
    'mlaube': 'Mareike Laube', 'mlöchel': 'Max Löchel',
    'nwolf': 'Nicolas Wolf', 'nweber': 'Nina Weber',
    'onötzel': 'Oliver Nötzel', 'rkretschmer': 'Rick Kretschmer',
    'rschuchert': 'Richard Schuchert', 'rbraunsdorf': 'Robert Braunsdorf',
    'rkonietzny': 'Robert Konietzny', 'sbrause': 'Sebastian Brause',
    'sherbrich': 'Silvan Herbrich', 'saugustin': 'Sophie Augustin',
    'tgröbel': 'Toni Gröbel', 'thinze': 'Tom Hinze'
};
const KASSENWART_PASSWORT = 'Gut-Aussehend';
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 Stunden
const sessions = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [token, s] of sessions) {
        if (s.expires < now) sessions.delete(token);
    }
}, 60 * 60 * 1000);

function requireAuth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session || session.expires < Date.now()) {
        sessions.delete(token);
        return res.status(401).json({ error: 'Nicht angemeldet' });
    }
    req.userSession = session;
    next();
}

function requireKassenwart(req, res, next) {
    if (req.userSession.rolle !== 'kassenwart') {
        return res.status(403).json({ error: 'Keine Berechtigung' });
    }
    next();
}

app.post('/api/login', (req, res) => {
    const username = (req.body.username || '').toLowerCase().trim();
    const password = req.body.password || '';
    if (username === 'kassenwart') {
        if (password !== KASSENWART_PASSWORT) return res.status(401).json({ error: 'Falsches Passwort' });
        const token = crypto.randomUUID();
        sessions.set(token, { name: 'Kassenwart', username: 'kassenwart', rolle: 'kassenwart', expires: Date.now() + SESSION_TTL });
        return res.json({ token, name: 'Kassenwart', rolle: 'kassenwart' });
    }
    db.get('SELECT * FROM mitglieder WHERE username = ?', [username], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(401).json({ error: 'Benutzername nicht gefunden' });
        if (row.gesperrt) return res.status(403).json({ error: 'Dein Account ist gesperrt. Bitte wende dich an den Kassenwart.' });
        const token = crypto.randomUUID();
        sessions.set(token, { name: row.name, username: row.username, rolle: 'mitglied', expires: Date.now() + SESSION_TTL });
        res.json({ token, name: row.name, rolle: 'mitglied' });
    });
});

app.post('/api/logout', (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    sessions.delete(token);
    res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store');
        }
    }
}));

const db = new sqlite3.Database(path.join(__dirname, 'auslagen.db'), (err) => {
    if (err) { console.error('DB Fehler:', err); process.exit(1); }
    console.log('Datenbank verbunden');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS auslagen (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mitglied TEXT NOT NULL,
        betrag REAL NOT NULL,
        datum TEXT NOT NULL,
        zweck TEXT NOT NULL,
        kategorie TEXT NOT NULL,
        beleg TEXT,
        status TEXT DEFAULT 'offen',
        eingereichtAm TEXT NOT NULL,
        bezahltAm TEXT,
        historie TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS kategorien (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS einstellungen (
        schluessel TEXT PRIMARY KEY,
        wert TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS mitglieder (
        username TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        gesperrt INTEGER DEFAULT 0
    )`);

    const defaults = [
        'Kostüme', 'Gestaltung', 'Allgemeines', 'Bauen',
        'Altstadttanz', 'Weihnachtsfeier', 'Verpflegung bauen',
        'Wurfmaterial/Getränke', 'Technik'
    ];
    const stmt = db.prepare('INSERT OR IGNORE INTO kategorien (name) VALUES (?)');
    defaults.forEach(k => stmt.run(k));
    stmt.finalize();

    // Bestehende Nutzer in DB migrieren
    const seedStmt = db.prepare('INSERT OR IGNORE INTO mitglieder (username, name) VALUES (?, ?)');
    Object.entries(USERS).forEach(([u, n]) => seedStmt.run(u, n));
    seedStmt.finalize();

    db.run(`CREATE TABLE IF NOT EXISTS einzahlungen (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mitglied TEXT NOT NULL,
        betrag REAL NOT NULL,
        datum TEXT NOT NULL,
        zweck TEXT NOT NULL,
        erfasstAm TEXT NOT NULL
    )`);

    db.run(`INSERT OR IGNORE INTO einstellungen (schluessel, wert) VALUES ('kassenbestand', '5000')`);

    // Migration: Soft-Delete Spalten hinzufügen falls noch nicht vorhanden
    db.run(`ALTER TABLE auslagen ADD COLUMN geloescht INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE auslagen ADD COLUMN geloeschtAm TEXT`, () => console.log('Bereit'));
});

app.get('/api/mitglieder', requireAuth, (req, res) => {
    db.all('SELECT name FROM mitglieder WHERE gesperrt = 0 ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => r.name));
    });
});

app.get('/api/mitglieder/admin', requireAuth, requireKassenwart, (req, res) => {
    db.all('SELECT username, name, gesperrt FROM mitglieder ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/mitglieder', requireAuth, requireKassenwart, (req, res) => {
    const username = (req.body.username || '').toLowerCase().trim();
    const name = (req.body.name || '').trim();
    if (!username || !name) return res.status(400).json({ error: 'Username und Name erforderlich' });
    if (username === 'kassenwart') return res.status(400).json({ error: 'Dieser Username ist reserviert' });
    db.run('INSERT INTO mitglieder (username, name) VALUES (?, ?)', [username, name], function(err) {
        if (err) return res.status(409).json({ error: 'Username bereits vergeben' });
        res.json({ ok: true });
    });
});

app.patch('/api/mitglieder/:username/sperren', requireAuth, requireKassenwart, (req, res) => {
    const { gesperrt } = req.body;
    const username = req.params.username;
    db.run('UPDATE mitglieder SET gesperrt = ? WHERE username = ?', [gesperrt ? 1 : 0, username], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (gesperrt) {
            for (const [token, s] of sessions) {
                if (s.username === username) sessions.delete(token);
            }
        }
        res.json({ ok: true });
    });
});

app.delete('/api/mitglieder/:username', requireAuth, requireKassenwart, (req, res) => {
    const username = req.params.username;
    for (const [token, s] of sessions) {
        if (s.username === username) sessions.delete(token);
    }
    db.run('DELETE FROM mitglieder WHERE username = ?', [username], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
    });
});

// --- Auslagen ---

app.get('/api/auslagen', requireAuth, (req, res) => {
    const isKassenwart = req.userSession.rolle === 'kassenwart';
    const query = isKassenwart
        ? 'SELECT * FROM auslagen ORDER BY eingereichtAm DESC'
        : 'SELECT * FROM auslagen WHERE geloescht = 0 ORDER BY eingereichtAm DESC';
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        rows.forEach(r => {
            if (r.historie) try { r.historie = JSON.parse(r.historie); } catch { r.historie = []; }
        });
        res.json(rows);
    });
});

app.post('/api/auslagen', requireAuth, (req, res) => {
    const { mitglied, betrag, datum, zweck, kategorie, beleg } = req.body;
    if (!mitglied || betrag === undefined || betrag === null || betrag === '' || !datum || !zweck || !kategorie) {
        return res.status(400).json({ error: 'Pflichtfelder fehlen' });
    }
    const now = new Date().toISOString();
    const historie = JSON.stringify([{ zeitpunkt: now, aktion: 'Erstellt', benutzer: mitglied }]);
    db.run(
        `INSERT INTO auslagen (mitglied, betrag, datum, zweck, kategorie, beleg, eingereichtAm, historie)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [mitglied, betrag, datum, zweck, kategorie, beleg || null, now, historie],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        }
    );
});

app.put('/api/auslagen/:id', requireAuth, (req, res) => {
    const { betrag, datum, zweck, kategorie, historie } = req.body;
    db.run(
        `UPDATE auslagen SET betrag=?, datum=?, zweck=?, kategorie=?, historie=? WHERE id=?`,
        [betrag, datum, zweck, kategorie, JSON.stringify(historie), req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        }
    );
});

app.patch('/api/auslagen/:id/status', requireAuth, requireKassenwart, (req, res) => {
    const { status } = req.body;
    const bezahltAm = status === 'bezahlt' ? new Date().toISOString() : null;
    db.run(
        'UPDATE auslagen SET status=?, bezahltAm=? WHERE id=?',
        [status, bezahltAm, req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        }
    );
});

app.delete('/api/auslagen/:id', requireAuth, (req, res) => {
    const now = new Date().toISOString();
    const geloeschtVon = req.userSession.name;
    db.run(
        'UPDATE auslagen SET geloescht=1, geloeschtAm=? WHERE id=? AND geloescht=0',
        [now, req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Nicht gefunden oder bereits gelöscht' });
            res.json({ ok: true });
        }
    );
});

// --- Kategorien ---

app.get('/api/kategorien', requireAuth, (req, res) => {
    db.all('SELECT name FROM kategorien ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => r.name));
    });
});

app.post('/api/kategorien', requireAuth, requireKassenwart, (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name fehlt' });
    db.run('INSERT INTO kategorien (name) VALUES (?)', [name.trim()], function(err) {
        if (err) return res.status(409).json({ error: 'Kategorie existiert bereits' });
        res.json({ ok: true });
    });
});

app.delete('/api/kategorien/:name', requireAuth, requireKassenwart, (req, res) => {
    const name = decodeURIComponent(req.params.name);
    db.run('DELETE FROM kategorien WHERE name=?', [name], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
    });
});

// --- Massenerfassung ---

app.post('/api/auslagen/massen', requireAuth, requireKassenwart, (req, res) => {
    const { mitglieder, betrag, datum, zweck, kategorie } = req.body;
    if (!Array.isArray(mitglieder) || !mitglieder.length || betrag === undefined || !datum || !zweck || !kategorie) {
        return res.status(400).json({ error: 'Pflichtfelder fehlen' });
    }
    const now = new Date().toISOString();
    const stmt = db.prepare(
        `INSERT INTO auslagen (mitglied, betrag, datum, zweck, kategorie, eingereichtAm, historie)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    let inserted = 0;
    db.serialize(() => {
        mitglieder.forEach(mitglied => {
            const historie = JSON.stringify([{ zeitpunkt: now, aktion: 'Massenerfassung', benutzer: 'Kassenwart' }]);
            stmt.run([mitglied, betrag, datum, zweck, kategorie, now, historie], (err) => { if (!err) inserted++; });
        });
        stmt.finalize(() => res.json({ ok: true, inserted }));
    });
});

// --- Bulk Import ---

app.post('/api/auslagen/bulk', requireAuth, requireKassenwart, (req, res) => {
    const { auslagen } = req.body;
    if (!Array.isArray(auslagen) || auslagen.length === 0) {
        return res.status(400).json({ error: 'Keine Daten' });
    }
    const now = new Date().toISOString();
    const stmt = db.prepare(
        `INSERT INTO auslagen (mitglied, betrag, datum, zweck, kategorie, status, eingereichtAm, historie)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let inserted = 0;
    db.serialize(() => {
        auslagen.forEach(a => {
            const historie = JSON.stringify([{ zeitpunkt: now, aktion: 'Importiert', benutzer: 'Import' }]);
            stmt.run([a.mitglied, a.betrag, a.datum, a.zweck, a.kategorie, a.status || 'offen', now, historie],
                (err) => { if (!err) inserted++; });
        });
        stmt.finalize(() => res.json({ ok: true, inserted }));
    });
});

// --- Kassenbestand ---

app.get('/api/kassenbestand', requireAuth, (req, res) => {
    db.get("SELECT wert FROM einstellungen WHERE schluessel = 'kassenbestand'", [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ kassenbestand: row ? parseFloat(row.wert) : 5000 });
    });
});

// --- CSV Export → Google Drive ---

function buildCsv(rows) {
    const header = 'Datum;Mitglied;Kategorie;Zweck;Betrag (EUR);Status;Eingereicht am;Bezahlt am';
    const lines = rows.map(a => [
        a.datum,
        a.mitglied,
        a.kategorie,
        `"${(a.zweck || '').replace(/"/g, '""')}"`,
        parseFloat(a.betrag).toFixed(2),
        a.status,
        new Date(a.eingereichtAm).toLocaleDateString('de-DE'),
        a.bezahltAm ? new Date(a.bezahltAm).toLocaleDateString('de-DE') : ''
    ].join(';'));
    return '﻿' + [header, ...lines].join('\r\n');
}

app.post('/api/auslagen/export-gdrive', requireAuth, requireKassenwart, (req, res) => {
    db.all('SELECT * FROM auslagen ORDER BY eingereichtAm DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        const filename = `auslagen_export_${timestamp}.csv`;
        const filepath = `/home/pi/backups/${filename}`;
        try {
            fs.writeFileSync(filepath, buildCsv(rows), 'utf-8');
        } catch (e) {
            return res.status(500).json({ error: 'Datei konnte nicht erstellt werden: ' + e.message });
        }
        exec(`rclone copy "${filepath}" gdrive:Auslagen-Backup/Exporte`, (rcloneErr) => {
            if (rcloneErr) {
                console.error('rclone Fehler:', rcloneErr);
                return res.status(500).json({ error: 'Google Drive Upload fehlgeschlagen' });
            }
            res.json({ ok: true, datei: filename });
        });
    });
});

// --- Einzahlungen ---

app.get('/api/einzahlungen', requireAuth, requireKassenwart, (req, res) => {
    db.all('SELECT * FROM einzahlungen ORDER BY erfasstAm DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/einzahlungen', requireAuth, requireKassenwart, (req, res) => {
    const { mitglied, betrag, datum, zweck } = req.body;
    if (!mitglied || betrag === undefined || betrag === null || betrag === '' || !datum || !zweck) {
        return res.status(400).json({ error: 'Pflichtfelder fehlen' });
    }
    const b = parseFloat(betrag);
    if (isNaN(b) || b <= 0) return res.status(400).json({ error: 'Betrag muss größer als 0 sein' });
    const now = new Date().toISOString();
    db.serialize(() => {
        db.run(
            'INSERT INTO einzahlungen (mitglied, betrag, datum, zweck, erfasstAm) VALUES (?, ?, ?, ?, ?)',
            [mitglied, b, datum, zweck, now],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                db.run(
                    `UPDATE einstellungen SET wert = CAST(CAST(wert AS REAL) + ? AS TEXT) WHERE schluessel = 'kassenbestand'`,
                    [b],
                    (err2) => {
                        if (err2) return res.status(500).json({ error: err2.message });
                        res.json({ id: this.lastID });
                    }
                );
            }
        );
    });
});

// --- Kassensturz ---

app.post('/api/kassensturz', requireAuth, requireKassenwart, (req, res) => {
    const neuerKassenstand = parseFloat(req.body.neuerKassenstand);
    if (isNaN(neuerKassenstand) || neuerKassenstand < 0) {
        return res.status(400).json({ error: 'Ungültiger Kassenstand' });
    }

    db.all('SELECT * FROM auslagen ORDER BY eingereichtAm DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        const filename = `kassensturz_${timestamp}.csv`;
        const filepath = `/home/pi/backups/${filename}`;

        try {
            fs.writeFileSync(filepath, buildCsv(rows), 'utf-8');
        } catch (e) {
            return res.status(500).json({ error: 'CSV konnte nicht erstellt werden: ' + e.message });
        }

        exec(`rclone copy "${filepath}" gdrive:Auslagen-Backup/Kassensturz`, (rcloneErr) => {
            if (rcloneErr) console.error('rclone Fehler (nicht kritisch):', rcloneErr);

            db.serialize(() => {
                db.run('DELETE FROM auslagen', [], (delErr) => {
                    if (delErr) return res.status(500).json({ error: delErr.message });
                    db.run('DELETE FROM einzahlungen', [], () => {});
                    db.run(
                        `INSERT INTO einstellungen (schluessel, wert) VALUES ('kassenbestand', ?)
                         ON CONFLICT(schluessel) DO UPDATE SET wert = excluded.wert`,
                        [String(neuerKassenstand)],
                        (settErr) => {
                            if (settErr) return res.status(500).json({ error: settErr.message });
                            res.json({ ok: true, datei: filename, rcloneOk: !rcloneErr });
                        }
                    );
                });
            });
        });
    });
});

app.listen(PORT, () => console.log(`Server läuft auf http://localhost:${PORT}`));
