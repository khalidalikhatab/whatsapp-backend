const crypto = require('crypto');
globalThis.crypto = crypto;

const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const cors = require('cors');
const pino = require('pino');
const fs = require('fs');

const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

const PORT = process.env.PORT || 3000;

let sock = null;
let qrCodeData = null;
let connectionStatus = 'initializing';
const serverLogs = [];

function log(message) {
    const timestamp = new Date().toISOString();
    const entry = `${timestamp} - ${message}`;
    console.log(entry);
    serverLogs.unshift(entry);
    if (serverLogs.length > 50) serverLogs.pop();
}

const AUTH_DIR = './auth_info';

async function connectToWhatsApp() {
    try {
        log('Connecting to WhatsApp...');
        connectionStatus = 'connecting';

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();
        log(`WhatsApp version: ${version.join('.')}`);

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            browser: ['WhatsApp Bot', 'Chrome', '1.0'],
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000
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
                    log('Logged out - clearing session');
                    connectionStatus = 'logged_out';
                    if (fs.existsSync(AUTH_DIR)) {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    }
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
    res.send(`
        <html>
        <head><title>WhatsApp Bot</title></head>
        <body style="font-family: Arial; padding: 40px; text-align: center;">
            <h1>WhatsApp Bot</h1>
            <p>Status: <strong>${connectionStatus}</strong></p>
            <p><a href="/qr">QR API</a> | <a href="/logs">Logs</a> | <a href="/reset">Reset</a></p>
        </body>
        </html>
    `);
});

app.get('/qr', (req, res) => {
    res.json({ status: connectionStatus, qr: qrCodeData });
});

app.get('/logs', (req, res) => {
    res.json({ logs: serverLogs });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', whatsapp: connectionStatus });
});

app.get('/reset', (req, res) => {
    log('Manual reset');
    if (sock) { try { sock.end(); } catch (e) { } }
    if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
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
log('Starting server...');
app.listen(PORT, '0.0.0.0', () => {
    log(`Server on port ${PORT}`);
    connectToWhatsApp();
});

process.on('SIGTERM', () => {
    log('Shutting down...');
    if (sock) sock.end();
    process.exit(0);
});
