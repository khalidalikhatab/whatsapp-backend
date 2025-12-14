const crypto = require('crypto');
globalThis.crypto = crypto;

const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const cors = require('cors');
const pino = require('pino');
const { Pool } = require('pg');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

// PostgreSQL connection
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: false
});

let sock = null;
let qrCodeData = null;
let connectionStatus = 'initializing';
const serverLogs = [];

function log(msg) {
    const entry = `${new Date().toISOString()} - ${msg}`;
    console.log(entry);
    serverLogs.unshift(entry);
    if (serverLogs.length > 50) serverLogs.pop();
}

// Initialize database table
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS auth_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        `);
        log('Database initialized');
    } catch (err) {
        log(`DB init error: ${err.message}`);
    }
}

// PostgreSQL-based auth state
async function usePostgresAuthState() {
    const writeData = async (key, data) => {
        const value = JSON.stringify(data, BufferJSON.replacer);
        await pool.query(
            'INSERT INTO auth_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
            [key, value]
        );
    };

    const readData = async (key) => {
        const result = await pool.query('SELECT value FROM auth_state WHERE key = $1', [key]);
        if (result.rows.length > 0) {
            return JSON.parse(result.rows[0].value, BufferJSON.reviver);
        }
        return null;
    };

    const removeData = async (key) => {
        await pool.query('DELETE FROM auth_state WHERE key = $1', [key]);
    };

    const clearAll = async () => {
        await pool.query('DELETE FROM auth_state');
    };

    // Load creds
    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const value = await readData(`${type}-${id}`);
                        if (value) {
                            if (type === 'app-state-sync-key') {
                                data[id] = proto.Message.AppStateSyncKeyData.fromObject(value);
                            } else {
                                data[id] = value;
                            }
                        }
                    }
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            if (value) {
                                await writeData(`${category}-${id}`, value);
                            } else {
                                await removeData(`${category}-${id}`);
                            }
                        }
                    }
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', creds);
        },
        clearAll
    };
}

async function connectToWhatsApp() {
    try {
        log('Connecting to WhatsApp...');
        connectionStatus = 'connecting';

        const { state, saveCreds, clearAll } = await usePostgresAuthState();
        const { version } = await fetchLatestBaileysVersion();
        log(`WhatsApp version: ${version.join('.')}`);

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '114.0.0'],
            connectTimeoutMs: 120000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            emitOwnEvents: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            generateHighQualityLinkPreview: false
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                log('QR Code received');
                connectionStatus = 'scanning';
                qrCodeData = await QRCode.toDataURL(qr);
            }

            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                log(`Disconnected (code: ${code})`);
                qrCodeData = null;

                if (code === DisconnectReason.loggedOut) {
                    log('Logged out - clearing session from database');
                    connectionStatus = 'logged_out';
                    await clearAll();
                } else {
                    connectionStatus = 'reconnecting';
                }
                setTimeout(connectToWhatsApp, 5000);
            } else if (connection === 'open') {
                log('Connected to WhatsApp!');
                connectionStatus = 'connected';
                qrCodeData = null;
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe && msg.message) {
                        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                        if (text) {
                            log(`Message: ${msg.key.remoteJid}: ${text}`);
                            await sock.sendMessage(msg.key.remoteJid, {
                                text: `I received: "${text}"`
                            });
                        }
                    }
                }
            }
        });

    } catch (err) {
        log(`Error: ${err.message}`);
        connectionStatus = 'error';
        setTimeout(connectToWhatsApp, 10000);
    }
}

// Routes
app.get('/', (req, res) => {
    res.send(`<html><head><title>WhatsApp Bot</title></head>
    <body style="font-family:Arial;padding:40px;text-align:center;">
    <h1>WhatsApp Bot (PostgreSQL Session)</h1>
    <p>Status: <strong>${connectionStatus}</strong></p>
    <p><a href="/qr">QR</a> | <a href="/logs">Logs</a> | <a href="/reset">Reset</a></p>
    </body></html>`);
});

app.get('/qr', (req, res) => {
    res.json({ status: connectionStatus, qr: qrCodeData });
});

app.get('/logs', (req, res) => {
    res.json({ logs: serverLogs });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', whatsapp: connectionStatus, db: 'postgresql' });
});

app.get('/reset', async (req, res) => {
    log('Manual reset - clearing database session');
    if (sock) { try { sock.end(); } catch (e) { } }
    await pool.query('DELETE FROM auth_state');
    connectionStatus = 'disconnected';
    qrCodeData = null;
    sock = null;
    setTimeout(connectToWhatsApp, 2000);
    res.json({ success: true });
});

app.post('/send', async (req, res) => {
    if (!sock || connectionStatus !== 'connected') {
        return res.status(400).json({ error: 'Not connected' });
    }
    const { to, text } = req.body;
    try {
        await sock.sendMessage(`${to}@s.whatsapp.net`, { text });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start
log('Starting server with PostgreSQL session storage...');
initDB().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        log(`Server on port ${PORT}`);
        connectToWhatsApp();
    });
});

process.on('SIGTERM', () => {
    log('Shutting down...');
    if (sock) sock.end();
    pool.end();
    process.exit(0);
});
