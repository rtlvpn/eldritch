const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const https = require('https');
const fs = require('fs');
const cors = require('cors');
const app = express();
const port = 3000; // Standard HTTPS port

// Enable CORS for all routes
app.use(cors({
    origin: ['https://rtlvpn.github.io', 'http://localhost:3000'],  // Add any other allowed origins
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

// SSL certificate configuration
const credentials = {
  key: fs.readFileSync('/etc/letsencrypt/live/eldritch.gleeze.com/privkey.pem', 'utf8'),
  cert: fs.readFileSync('/etc/letsencrypt/live/eldritch.gleeze.com/fullchain.pem', 'utf8')
};

// Connect to the same database file
const db = new sqlite3.Database('./trc20_transfers.db', (err) => {
    if (err) {
        console.error('Error connecting to database:', err);
    } else {
        console.log('Connected to database successfully');
    }
});

// GET endpoint to fetch all transfers
app.get('/transfers', (req, res) => {
    db.all('SELECT * FROM trc20_transfers ORDER BY timestamp DESC', [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({
            message: 'success',
            data: rows
        });
    });
});

// GET endpoint to fetch transfers by date range
app.get('/transfers/range', (req, res) => {
    const { start_date, end_date } = req.query;
    
    db.all(
        'SELECT * FROM trc20_transfers WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp DESC',
        [start_date, end_date],
        (err, rows) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({
                message: 'success',
                data: rows
            });
        }
    );
});

app.get('/transfers/paginated', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const offset = (page - 1) * limit;
    
    db.all(
        'SELECT * FROM trc20_transfers ORDER BY timestamp DESC LIMIT ? OFFSET ?',
        [limit, offset],
        (err, rows) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            db.get('SELECT COUNT(*) as total FROM trc20_transfers', [], (err, count) => {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                
                res.json({
                    message: 'success',
                    data: rows,
                    total: count.total,
                    current_page: page,
                    per_page: limit,
                    total_pages: Math.ceil(count.total / limit)
                });
            });
        }
    );
});

// Replace the app.listen with https server
const httpsServer = https.createServer(credentials, app);
httpsServer.listen(port, () => {
    console.log(`HTTPS Server running at https://localhost:${port}`);
});
