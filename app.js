/**
 * This script does the following:
 *  - Initializes a local SQLite database (database.db) and creates a table for snapshots.
 *  - Fetches an initial order book snapshot from Binance's REST API.
 *  - Subscribes to Binance's depth WebSocket (for symbol TRXUSDT) to update a local order book.
 *  - Every second, saves a snapshot (with bids and asks arrays) of the current order book into SQLite.
 *  - Every minute, deletes snapshots older than 2 days.
 *  - Provides API endpoints:
 *       o /api/orderbook/ticks    - aggregates snapshots into 1‐minute ticks (with a representative price)
 *       o /api/orderbook/heatmap  - aggregates ticks into a heatmap (order volume bucketed by price)
 *
 * Dependencies (install via npm):
 *    npm install express sqlite3 ws node-fetch
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const WebSocket = require('ws');
const fetch = require('node-fetch'); // In Node 18+, you can use global fetch

// ----- Additional requires for HTTPS -----
const fs = require('fs');
const https = require('https');

// ----- Configuration -----
const PORT = process.env.PORT || 3500;

// Paths to the Certbot generated certificates (PEM format)
// Adjust these paths to match your Certbot folder structure.
const CERT_PATH = process.env.CERT_PATH || '/etc/letsencrypt/live/eldritch.gleeze.com/fullchain.pem';
const PRIVKEY_PATH = process.env.PRIVKEY_PATH || '/etc/letsencrypt/live/eldritch.gleeze.com/privkey.pem';

// Load the certificate and private key files.
let credentials;
try {
  const privateKey = fs.readFileSync(PRIVKEY_PATH, 'utf8');
  const certificate = fs.readFileSync(CERT_PATH, 'utf8');
  credentials = { key: privateKey, cert: certificate };
  console.log("Successfully loaded SSL/TLS certificates.");
} catch (err) {
  console.error("Error loading SSL/TLS certificates:", err);
  process.exit(1);
}

// ----- Initialize SQLite Database -----
// The database file is created in the project root (database.db).
const db = new sqlite3.Database('database.db', (err) => {
  if (err) {
    console.error("Error opening SQLite database", err);
  } else {
    console.log("Connected to SQLite database.");
  }
});

// Create the snapshots table if not exists.
// We'll store: id, symbol, timestamp, bids, asks, price
// The timestamp is stored in SQLite's TEXT format ("YYYY-MM-DD HH:MM:SS")
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT,
      timestamp TEXT,
      bids TEXT,
      asks TEXT,
      price REAL
    )`,
    (err) => {
      if (err) console.error("Error creating table:", err);
    }
  );
});

// Helper: Format Date as "YYYY-MM-DD HH:MM:SS" in UTC
function formatUTCDate(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// ----- 1. Order Book Management (In-Memory) -----
let orderBook = {
  symbol: "TRXUSDT",
  lastUpdateId: 0, // last update id from Binance snapshot
  bids: {}, // { "price": volume }
  asks: {}  // { "price": volume }
};

/**
 * Fetch the initial order book snapshot from Binance.
 */
async function fetchInitialOrderBook() {
  try {
    const response = await fetch("https://api.binance.com/api/v3/depth?symbol=TRXUSDT&limit=100");
    const data = await response.json();
    orderBook.lastUpdateId = data.lastUpdateId;
    data.bids.forEach(bid => {
      const [price, volume] = bid;
      orderBook.bids[price] = parseFloat(volume);
    });
    data.asks.forEach(ask => {
      const [price, volume] = ask;
      orderBook.asks[price] = parseFloat(volume);
    });
    console.log("Initial order book retrieved. Last Update ID:", orderBook.lastUpdateId);
  } catch (err) {
    console.error("Error fetching initial order book:", err);
  }
}

/**
 * Process depth update messages from Binance WebSocket.
 */
function processDepthUpdate(message) {
  // Ignore updates that do not exceed the lastUpdateId.
  if (message.u <= orderBook.lastUpdateId) return;

  message.b.forEach(([price, volume]) => {
    if (parseFloat(volume) === 0) {
      delete orderBook.bids[price];
    } else {
      orderBook.bids[price] = parseFloat(volume);
    }
  });
  message.a.forEach(([price, volume]) => {
    if (parseFloat(volume) === 0) {
      delete orderBook.asks[price];
    } else {
      orderBook.asks[price] = parseFloat(volume);
    }
  });

  orderBook.lastUpdateId = message.u;
}

/**
 * Connect to Binance's depth WebSocket.
 */
function connectWebSocket() {
  const socketUrl = `wss://stream.binance.com:9443/ws/${orderBook.symbol.toLowerCase()}@depth`;
  const ws = new WebSocket(socketUrl);

  ws.on('open', () => {
    console.log("Connected to Binance depth WebSocket.");
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      processDepthUpdate(message);
    } catch (err) {
      console.error("Error processing WebSocket message:", err);
    }
  });

  ws.on('error', (err) => {
    console.error("WebSocket error:", err);
  });

  ws.on('close', () => {
    console.warn("WebSocket connection closed. Reconnecting in 5 seconds...");
    setTimeout(connectWebSocket, 5000);
  });
}

/**
 * Fetch current price from Binance API
 */
async function fetchCurrentPrice(symbol) {
  try {
    const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    const data = await response.json();
    return parseFloat(data.price);
  } catch (err) {
    console.error("Error fetching current price:", err);
    return null;
  }
}

/**
 * Save a snapshot of the current order book into SQLite.
 */
async function saveSnapshot() {
  try {
    // Convert bids and asks objects to sorted arrays.
    // Bids: sorted in descending order (highest price first)
    const bidsArray = Object.keys(orderBook.bids)
      .map(price => ({ price: parseFloat(price), volume: orderBook.bids[price] }))
      .sort((a, b) => b.price - a.price);
    // Asks: sorted in ascending order (lowest price first)
    const asksArray = Object.keys(orderBook.asks)
      .map(price => ({ price: parseFloat(price), volume: orderBook.asks[price] }))
      .sort((a, b) => a.price - b.price);

    // Fetch current price from Binance
    const currentPrice = await fetchCurrentPrice(orderBook.symbol);

    // Use UTC time consistently
    const now = new Date();
    const nowStr = formatUTCDate(now);
    const sql = `INSERT INTO snapshots (symbol, timestamp, bids, asks, price) VALUES (?, ?, ?, ?, ?)`;
    db.run(sql, [
      orderBook.symbol, 
      nowStr, 
      JSON.stringify(bidsArray), 
      JSON.stringify(asksArray),
      currentPrice
    ], function(err) {
      if (err) {
        console.error("Error saving snapshot:", err);
      }
    });
  } catch (err) {
    console.error("Error in saveSnapshot:", err);
  }
}

/**
 * Delete snapshots older than 2 days.
 */
function deleteOldSnapshots() {
  const cutoffDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const cutoffStr = formatUTCDate(cutoffDate);
  const sql = `DELETE FROM snapshots WHERE timestamp < ?`;
  db.run(sql, [cutoffStr], function(err) {
    if (err) {
      console.error("Error deleting old snapshots:", err);
    }
  });
}

// ----- 2. Express API Server -----
const app = express();

// --- CORS Middleware ---
app.use((req, res, next) => {
  // Allow any origin so that static HTML files from other domains can access the API
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Allow headers necessary for requests
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  // Optionally allow specific HTTP methods
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  next();
});

/**
 * Helper: Retrieve snapshots from SQLite for a given symbol and time range.
 * Returns an array of snapshots with bids and asks parsed from JSON.
 */
function getSnapshots(symbol, startStr, endStr) {
  return new Promise((resolve, reject) => {
    const sql = `SELECT * FROM snapshots WHERE symbol = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp ASC`;
    db.all(sql, [symbol, startStr, endStr], (err, rows) => {
      if (err) {
        return reject(err);
      }
      // Parse bids and asks from JSON strings.
      const snapshots = rows.map(row => ({
        id: row.id,
        symbol: row.symbol,
        timestamp: row.timestamp,
        bids: JSON.parse(row.bids),
        asks: JSON.parse(row.asks),
        price: row.price
      }));
      resolve(snapshots);
    });
  });
}

/**
 * Endpoint: /api/orderbook/ticks
 * 
 * Aggregates retrieved snapshots into 1-minute ticks.
 * For each minute, the last snapshot is used.
 * A representative price is computed as:
 *    - If both best bid and ask exist, use their average.
 *    - Otherwise, use whichever exists.
 */
app.get('/api/orderbook/ticks', async (req, res) => {
  try {
    const symbol = req.query.symbol || "TRXUSDT";
    // Ensure all date handling uses UTC consistently
    const end = req.query.end ? new Date(req.query.end) : new Date();
    const start = req.query.start ? new Date(req.query.start) : new Date(end.getTime() - 60 * 60 * 1000);
    const startStr = formatUTCDate(start);
    const endStr = formatUTCDate(end);

    const snapshots = await getSnapshots(symbol, startStr, endStr);
    // Group snapshots by minute (using the first 16 characters e.g. "YYYY-MM-DD HH:MM")
    const groups = {};
    snapshots.forEach(snapshot => {
      // Assume snapshot.timestamp format is "YYYY-MM-DD HH:MM:SS".
      const minuteKey = snapshot.timestamp.slice(0, 16) + ":00";
      // Overwrite so that the last snapshot in that minute is kept.
      groups[minuteKey] = snapshot;
    });
    // Sort the ticks by minute timestamp.
    const sortedMinutes = Object.keys(groups).sort();
    const ticks = sortedMinutes.map(minKey => {
      const tick = groups[minKey];
      return {
        timestamp: tick.timestamp,
        bids: tick.bids,
        asks: tick.asks,
        price: tick.price
      };
    });
    res.json(ticks);
  } catch (err) {
    console.error("Error in /api/orderbook/ticks:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * Endpoint: /api/orderbook/heatmap
 * 
 * Aggregates 1-minute tick snapshots into a heatmap structure.
 * The snapshots are bucketed by price into configurable buckets (default bucketSize = 0.001).
 * The response contains:
 *    - times: an array of tick timestamps,
 *    - buckets: an array of lower bucket price boundaries,
 *    - bidHeat: a 2D array (per tick, per price bucket) for bid volumes,
 *    - askHeat: a 2D array (per tick, per price bucket) for ask volumes.
 */
app.get('/api/orderbook/heatmap', async (req, res) => {
  try {
    const symbol = req.query.symbol || "TRXUSDT";
    const bucketSize = parseFloat(req.query.bucketSize) || 0.001;
    // Ensure all date handling uses UTC consistently
    const end = req.query.end ? new Date(req.query.end) : new Date();
    const start = req.query.start ? new Date(req.query.start) : new Date(end.getTime() - 60 * 60 * 1000);
    const startStr = formatUTCDate(start);
    const endStr = formatUTCDate(end);

    const snapshots = await getSnapshots(symbol, startStr, endStr);
    // Group snapshots by minute.
    const groups = {};
    snapshots.forEach(snapshot => {
      const minuteKey = snapshot.timestamp.slice(0, 16) + ":00";
      groups[minuteKey] = snapshot;
    });
    const sortedMinutes = Object.keys(groups).sort();
    const ticks = sortedMinutes.map(minKey => groups[minKey]);

    // Compute global price range across all ticks.
    let globalMin = Infinity, globalMax = -Infinity;
    ticks.forEach(tick => {
      const orders = (tick.bids || []).concat(tick.asks || []);
      orders.forEach(order => {
        if (order.price < globalMin) globalMin = order.price;
        if (order.price > globalMax) globalMax = order.price;
      });
    });
    if (!isFinite(globalMin) || !isFinite(globalMax)) {
      return res.json({ times: [], buckets: [], bidHeat: [], askHeat: [] });
    }

    const bucketCount = Math.ceil((globalMax - globalMin) / bucketSize);
    const buckets = Array.from({ length: bucketCount }, (_, i) => globalMin + i * bucketSize);

    const times = [];
    const bidHeat = []; // Each row corresponds to a tick's bid volume per bucket.
    const askHeat = []; // Each row corresponds to a tick's ask volume per bucket.

    ticks.forEach(tick => {
      times.push(tick.timestamp);
      let bidBuckets = new Array(bucketCount).fill(0);
      let askBuckets = new Array(bucketCount).fill(0);

      (tick.bids || []).forEach(order => {
        const idx = Math.floor((order.price - globalMin) / bucketSize);
        if (idx >= 0 && idx < bucketCount) {
          bidBuckets[idx] += order.volume;
        }
      });
      (tick.asks || []).forEach(order => {
        const idx = Math.floor((order.price - globalMin) / bucketSize);
        if (idx >= 0 && idx < bucketCount) {
          askBuckets[idx] += order.volume;
        }
      });
      bidHeat.push(bidBuckets);
      askHeat.push(askBuckets);
    });

    res.json({ times, buckets, bidHeat, askHeat });
  } catch (err) {
    console.error("Error in /api/orderbook/heatmap:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// A simple status endpoint.
app.get('/', (req, res) => {
  res.send("Binance Order Book Aggregator API using SQLite is running.");
});

// ----- 3. Start the Application -----
async function start() {
  try {
    // First, populate the order book using Binance REST snapshot.
    await fetchInitialOrderBook();
    // Connect to Binance WebSocket for live updates.
    connectWebSocket();
    // Save a snapshot every second.
    setInterval(saveSnapshot, 1000);
    // Clean out snapshots older than 2 days every minute.
    setInterval(deleteOldSnapshots, 60 * 1000);
    
    // Create an HTTPS server using the Certbot generated certificates.
    const httpsServer = https.createServer(credentials, app);
    httpsServer.listen(PORT, () => {
      console.log(`HTTPS server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Error starting application:", err);
  }
}

start(); 