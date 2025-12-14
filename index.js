const crypto = require('crypto');
globalThis.crypto = crypto;

const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const cors = require('cors');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
const serverLogs = [];
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

function log(message, ...args) {
    const timestamp = new Date().toISOString();
    const formattedMsg = `${timestamp} - ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`;
    console.log(formattedMsg);
    serverLogs.unshift(formattedMsg);
    if (serverLogs.length > 100) serverLogs.pop();
}

const AUTH_DIR = 'auth_info_baileys';

async function connectToWhatsApp() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        log('Max reconnect attempts reached. Use /reset to start fresh.');
        connectionStatus = 'error';
        return;
    }

    try {
        log('Starting connection process...');
        connectionStatus = 'connecting';

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        log(`Using WA version v${version.join('.')}, isLatest: ${isLatest}`);

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            browser: ["WhatsApp Bot", "Chrome", "1.0"],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            emitOwnEvents: true,
            retryRequestDelayMs: 5000,
            markOnlineOnConnect: false
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    qrCodeData = await QRCode.toDataURL(qr);
                    connectionStatus = 'scanning';
                    log('QR Code generated - scan with WhatsApp');
                    reconnectAttempts = 0; // Reset on QR generation
                } catch (err) {
                    log('Error generating QR:', err.message);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errorMessage = lastDisconnect?.error?.message || 'Unknown error';
                log(`Connection closed. StatusCode: ${statusCode}, Error: ${errorMessage}`);

                qrCodeData = null;
                sock = null;

                if (statusCode === DisconnectReason.loggedOut) {
                    log('Logged out. Clearing session...');
                    connectionStatus = 'logged_out';
                    if (fs.existsSync(AUTH_DIR)) {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    }
                    reconnectAttempts = 0;
                    setTimeout(connectToWhatsApp, 3000);
                } else {
                    connectionStatus = 'reconnecting';
                    reconnectAttempts++;
                    const delay = Math.min(5000 * reconnectAttempts, 30000);
                    log(`Reconnecting in ${delay}ms... (attempt ${reconnectAttempts})`);
                    setTimeout(connectToWhatsApp, delay);
                }
            } else if (connection === 'open') {
                log('Connected to WhatsApp!');
                connectionStatus = 'connected';
                qrCodeData = null;
                reconnectAttempts = 0;
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe && msg.message) {
                        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                        if (text) {
                            log('Message from:', msg.key.remoteJid, ':', text);
                            try {
                                await sock.sendMessage(msg.key.remoteJid, {
                                    text: `Hello! I am an AI assistant. I received: "${text}"`
                                });
                            } catch (err) {
                                log('Error sending reply:', err.message);
                            }
                        }
                    }
                }
            }
        });

    } catch (err) {
        log('Fatal error:', err.message);
        connectionStatus = 'error';
        reconnectAttempts++;
        setTimeout(connectToWhatsApp, 10000);
    }
}

// API Endpoints
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>WhatsApp Bot</title></head>
        <body style="font-family: Arial; padding: 20px;">
            <h1>WhatsApp Bot Server</h1>
            <p>Status: <strong>${connectionStatus}</strong></p>
            <p><a href="/qr">Get QR Code</a> | <a href="/logs">Logs</a> | <a href="/reset">Reset</a></p>
        </body>
        </html>
    `);
});

app.get('/qr', (req, res) => {
    res.json({
        status: connectionStatus,
        qr: qrCodeData || null
    });
});

app.get('/logs', (req, res) => {
    res.json({ logs: serverLogs });
});

app.get('/reset', (req, res) => {
    log('Manual reset requested...');

    if (sock) {
        try { sock.end(); } catch (e) { }
        sock = null;
    }

    if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }

    connectionStatus = 'disconnected';
    qrCodeData = null;
    reconnectAttempts = 0;

    setTimeout(connectToWhatsApp, 2000);
    res.json({ success: true, message: 'Session reset. New QR coming...' });
});

app.post('/send', async (req, res) => {
    const { to, text } = req.body;
    if (!sock) return res.status(500).json({ error: 'Not connected' });

    try {
        const id = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        await sock.sendMessage(id, { text });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', whatsapp: connectionStatus });
});

// Start
log('Starting WhatsApp Bot Server...');
app.listen(PORT, '0.0.0.0', () => {
    log(`Server running on port ${PORT}`);
    connectToWhatsApp();
});
