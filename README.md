# WhatsApp Bot - Railway Backend

## Deploy to Railway

1. Go to [Railway.app](https://railway.app)
2. Sign in with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select this repository
5. Railway will auto-detect Node.js and deploy

## Environment Variables

No environment variables needed - PORT is auto-set by Railway.

## API Endpoints

- `GET /` - Status page
- `GET /qr` - Get QR code for scanning
- `GET /logs` - View server logs
- `POST /send` - Send a message (body: { to: "phone", text: "message" })
- `GET /health` - Health check
