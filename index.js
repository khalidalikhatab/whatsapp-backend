// Fix for "crypto is not defined" in newer Node.js versions
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

let sock;
let qrCodeData = null;
let connectionStatus = 'disconnected';
const serverLogs = [];

function log(message, ...args) {
    const timestamp = new Date().toISOString();
    const formattedMsg = `${timestamp} - ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`;
    console.log(formattedMsg);
    serverLogs.unshift(formattedMsg);
    if (serverLogs.length > 100) serverLogs.pop();
}

const AUTH_DIR = 'auth_info_baileys';

// Don't clear auth on every start - we want to persist the session
// Only clear if there's corruption

async function connectToWhatsApp() {
    try {
        log('Starting connection process...');
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
            keepAliveIntervalMs: 25000,
            emitOwnEvents: true,
            retryRequestDelayMs: 5000
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCodeData = qr;
                connectionStatus = 'scanning';
                log('QR Code received - scan with WhatsApp');
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                log('Connection closed. StatusCode:', statusCode, 'Error:', lastDisconnect?.error?.message);

                if (shouldReconnect) {
                    const delay = statusCode === 408 ? 10000 : 5000;
                    log(`Reconnecting in ${delay}ms...`);
                    setTimeout(connectToWhatsApp, delay);
                } else {
                    connectionStatus = 'logged_out';
                    qrCodeData = null;
                    log('Logged out. Please scan QR again.');
                    // Clear auth on logout
                    if (fs.existsSync(AUTH_DIR)) {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    }
                    setTimeout(connectToWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                log('Connected to WhatsApp!');
                connectionStatus = 'connected';
                qrCodeData = null;
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe && msg.message) {
                        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                        log('Message from', msg.key.remoteJid, ':', text);

                        // Auto-reply
                        await sock.sendMessage(msg.key.remoteJid, {
                            text: 'Hello! I am an AI assistant. I received your message: "' + text + '"'
                        });
                    }
                }
            }
        });
    } catch (err) {
        log('FATAL ERROR in connectToWhatsApp:', err.message);
        connectionStatus = 'error';
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
            <p><a href="/qr">Get QR Code API</a></p>
            <p><a href="/logs">View Logs</a></p>
        </body>
        </html>
    `);
});

app.get('/qr', async (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({ status: 'connected', qr: null });
    }
    if (qrCodeData) {
        try {
            const qrImage = await QRCode.toDataURL(qrCodeData);
            return res.json({ status: 'scanning', qr: qrImage });
        } catch (err) {
            return res.status(500).json({ error: 'Failed to generate QR' });
        }
    }
    res.json({ status: connectionStatus, qr: null });
});

app.get('/logs', (req, res) => {
    res.json({ logs: serverLogs });
});

app.post('/send', async (req, res) => {
    const { to, text } = req.body;
    if (!sock) return res.status(500).json({ error: 'Bot not initialized' });

    try {
        const id = to.includes('@') ? to : to + '@s.whatsapp.net';
        await sock.sendMessage(id, { text });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Health check for Railway
app.get('/health', (req, res) => {
    res.json({ status: 'ok', whatsapp: connectionStatus });
});

// Start
log('Starting WhatsApp Bot Server...');
connectToWhatsApp();

app.listen(PORT, '0.0.0.0', () => {
    log(`Server running on port ${PORT}`);
});
