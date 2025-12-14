const express = require('express');
const cors = require('cors');

const app = express();

// Enable CORS for all origins
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Get port from Railway environment
const PORT = process.env.PORT || 3000;

console.log('=== WhatsApp Bot Server ===');
console.log(`Environment PORT: ${process.env.PORT}`);
console.log(`Using PORT: ${PORT}`);

// Root endpoint
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>WhatsApp Bot</title></head>
        <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
            <h1>✅ WhatsApp Bot Server</h1>
            <p>Status: <strong style="color: green;">RUNNING</strong></p>
            <p>Port: ${PORT}</p>
            <hr>
            <p><a href="/qr">QR Code API</a> | <a href="/health">Health Check</a></p>
        </body>
        </html>
    `);
});

// Health check endpoint (required by Railway)
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        port: PORT
    });
});

// QR endpoint (placeholder for now)
app.get('/qr', (req, res) => {
    res.json({
        status: 'waiting',
        message: 'WhatsApp connector will be added once server is confirmed working',
        qr: null
    });
});

// Logs endpoint
app.get('/logs', (req, res) => {
    res.json({
        logs: [`Server started on port ${PORT}`, 'Waiting for WhatsApp integration...']
    });
});

// Start server - Railway requires binding to 0.0.0.0
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server is listening on 0.0.0.0:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});

// Handle shutdown gracefully
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
