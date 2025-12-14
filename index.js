const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Just a simple test
app.get('/', (req, res) => {
    res.json({ status: 'Server is running!', port: PORT });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

console.log(`Starting server on port ${PORT}...`);
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
