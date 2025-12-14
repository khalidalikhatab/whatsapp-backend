const wppconnect = require('@wppconnect-team/wppconnect');
const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let client = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
const serverLogs = [];

function log(message, ...args) {
    const timestamp = new Date().toISOString();
    const formattedMsg = `${timestamp} - ${message} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
    console.log(formattedMsg);
    serverLogs.unshift(formattedMsg);
    if (serverLogs.length > 100) serverLogs.pop();
}

async function startWhatsApp() {
    try {
        log('Starting WPPConnect...');
        connectionStatus = 'starting';

        client = await wppconnect.create({
            session: 'whatsapp-bot',
            catchQR: (base64Qr, asciiQR, attempts) => {
                log(`QR Code received (attempt ${attempts})`);
                qrCodeData = base64Qr;
                connectionStatus = 'scanning';
            },
            statusFind: (statusSession, session) => {
                log('Status:', statusSession);
                if (statusSession === 'isLogged' || statusSession === 'inChat') {
                    connectionStatus = 'connected';
                    qrCodeData = null;
                } else if (statusSession === 'notLogged' || statusSession === 'browserClose') {
                    connectionStatus = 'disconnected';
                }
            },
            headless: true,
            devtools: false,
            useChrome: false,
            debug: false,
            logQR: true,
            browserWS: '',
            browserArgs: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ],
            puppeteerOptions: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            },
            autoClose: 0,
            folderNameToken: 'tokens',
        });

        log('WPPConnect client created successfully');
        connectionStatus = 'connected';
        qrCodeData = null;

        // Listen for messages
        client.onMessage(async (message) => {
            if (!message.isGroupMsg && message.body) {
                log('Message from:', message.from, ':', message.body);

                // Auto-reply
                try {
                    await client.sendText(
                        message.from,
                        `Hello! I am an AI assistant. I received your message: "${message.body}"`
                    );
                    log('Reply sent to:', message.from);
                } catch (err) {
                    log('Error sending reply:', err.message);
                }
            }
        });

        // Handle disconnection
        client.onStateChange((state) => {
            log('State changed to:', state);
            if (state === 'CONFLICT' || state === 'UNLAUNCHED' || state === 'DISCONNECTED') {
                connectionStatus = 'disconnected';
                log('Disconnected. Will need to scan QR again.');
            }
        });

    } catch (err) {
        log('Error starting WPPConnect:', err.message);
        connectionStatus = 'error';
        // Retry after delay
        setTimeout(startWhatsApp, 30000);
    }
}

// API Endpoints
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>WhatsApp Bot</title></head>
        <body style="font-family: Arial; padding: 20px;">
            <h1>WhatsApp Bot Server (WPPConnect)</h1>
            <p>Status: <strong>${connectionStatus}</strong></p>
            <p><a href="/qr">Get QR Code API</a></p>
            <p><a href="/logs">View Logs</a></p>
            <p><a href="/reset">Reset Session</a></p>
        </body>
        </html>
    `);
});

app.get('/qr', async (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({ status: 'connected', qr: null });
    }
    if (qrCodeData) {
        return res.json({ status: 'scanning', qr: qrCodeData });
    }
    res.json({ status: connectionStatus, qr: null });
});

app.get('/logs', (req, res) => {
    res.json({ logs: serverLogs });
});

app.post('/send', async (req, res) => {
    const { to, text } = req.body;
    if (!client) return res.status(500).json({ error: 'Bot not initialized' });

    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        await client.sendText(chatId, text);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/reset', async (req, res) => {
    log('Manual reset requested...');
    try {
        if (client) {
            await client.close();
        }
    } catch (e) {
        log('Error closing client:', e.message);
    }

    // Clear token folder
    const tokenPath = './tokens';
    if (fs.existsSync(tokenPath)) {
        fs.rmSync(tokenPath, { recursive: true, force: true });
        log('Token folder cleared');
    }

    connectionStatus = 'disconnected';
    qrCodeData = null;
    client = null;

    // Restart after a short delay
    setTimeout(startWhatsApp, 3000);

    res.json({ success: true, message: 'Session reset. New QR will appear shortly.' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', whatsapp: connectionStatus });
});

// Start server
log('Starting WhatsApp Bot Server...');
app.listen(PORT, '0.0.0.0', () => {
    log(`Server running on port ${PORT}`);
    startWhatsApp();
});
