/**
 * Enhanced Orderbook Heatmap Service
 * 
 * This application provides high-quality order book data for professional heatmap visualization:
 *  - Captures and stores full order book data at configurable intervals
 *  - Tracks liquidity changes over time with price-level granularity
 *  - Provides liquidation levels, imbalance metrics, and volume deltas
 *  - Generates complete heatmap data for visualization libraries
 *  - Supports historical data replay and real-time streaming
 * 
 * Dependencies: express, sqlite3, ws, node-fetch
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const WebSocket = require('ws');
const fetch = require('node-fetch');
const fs = require('fs');
const https = require('https');

// ----- Configuration -----
const PORT = process.env.PORT || 3500;
const SYMBOL = process.env.SYMBOL || 'TRXUSDT';
const SNAPSHOT_INTERVAL_MS = 500; // 500ms (2x per second) for more granular data
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Hourly cleanup
const RETENTION_DAYS = 7; // Keep 7 days of data for better historical analysis
const MAX_LEVELS = 500; // Track more price levels for better depth visualization

// Paths to the Certbot generated certificates
const CERT_PATH = process.env.CERT_PATH || '/etc/letsencrypt/live/eldritch.gleeze.com/fullchain.pem';
const PRIVKEY_PATH = process.env.PRIVKEY_PATH || '/etc/letsencrypt/live/eldritch.gleeze.com/privkey.pem';

// Load the certificate and private key files
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
const db = new sqlite3.Database('orderbook_heatmap.db', (err) => {
  if (err) {
    console.error("Error opening SQLite database", err);
  } else {
    console.log("Connected to SQLite database.");
  }
});

// Enhanced schema for better heatmap data
db.serialize(() => {
  // Main snapshots table with improved structure
  db.run(
    `CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT,
      timestamp TEXT,
      bids TEXT,
      asks TEXT,
      mid_price REAL,
      spread REAL,
      bid_volume REAL,
      ask_volume REAL,
      imbalance REAL
    )`,
    (err) => {
      if (err) console.error("Error creating snapshots table:", err);
    }
  );
  
  // Price level changes table to track liquidity shifts
  db.run(
    `CREATE TABLE IF NOT EXISTS price_level_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER,
      timestamp TEXT,
      price REAL,
      bid_delta REAL,
      ask_delta REAL,
      is_bid BOOLEAN,
      FOREIGN KEY(snapshot_id) REFERENCES snapshots(id)
    )`,
    (err) => {
      if (err) console.error("Error creating price_level_changes table:", err);
    }
  );
  
  // Create indices for faster queries
  db.run(`CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots(timestamp)`, 
    (err) => { if (err) console.error("Error creating snapshot index:", err); });
  db.run(`CREATE INDEX IF NOT EXISTS idx_snapshots_symbol ON snapshots(symbol)`,
    (err) => { if (err) console.error("Error creating symbol index:", err); });
  db.run(`CREATE INDEX IF NOT EXISTS idx_price_changes_snapshot ON price_level_changes(snapshot_id)`,
    (err) => { if (err) console.error("Error creating price changes index:", err); });
});

// Helper: Format Date as "YYYY-MM-DD HH:MM:SS.SSS" in UTC for millisecond precision
function formatUTCDate(date) {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

// ----- Order Book Management (In-Memory) -----
let orderBook = {
  symbol: SYMBOL,
  lastUpdateId: 0,
  lastUpdateTime: null,
  bids: {},  // { "price": volume }
  asks: {},  // { "price": volume }
  previousBids: {}, // For tracking changes
  previousAsks: {}, // For tracking changes
  priceChanges: [] // Recent price level changes
};

/**
 * Fetch the initial order book snapshot from Binance with max depth
 */
async function fetchInitialOrderBook() {
  try {
    const response = await fetch(`https://api.binance.com/api/v3/depth?symbol=${SYMBOL}&limit=1000`);
    const data = await response.json();
    
    orderBook.lastUpdateId = data.lastUpdateId;
    orderBook.lastUpdateTime = Date.now();
    
    // Store the previous state
    orderBook.previousBids = {...orderBook.bids};
    orderBook.previousAsks = {...orderBook.asks};
    
    // Clear and populate bids
    orderBook.bids = {};
    data.bids.forEach(bid => {
      const [price, volume] = bid;
      orderBook.bids[price] = parseFloat(volume);
    });
    
    // Clear and populate asks
    orderBook.asks = {};
    data.asks.forEach(ask => {
      const [price, volume] = ask;
      orderBook.asks[price] = parseFloat(volume);
    });
    
    console.log(`Initial order book retrieved for ${SYMBOL}. Last Update ID: ${orderBook.lastUpdateId}`);
  } catch (err) {
    console.error("Error fetching initial order book:", err);
  }
}

/**
 * Process depth update messages from Binance WebSocket and track price level changes
 */
function processDepthUpdate(message) {
  // Ignore updates that do not exceed the lastUpdateId
  if (message.u <= orderBook.lastUpdateId) return;
  
  // Track changes for each price level
  const changes = [];
  
  // Process bid updates
  message.b.forEach(([price, volume]) => {
    const numVolume = parseFloat(volume);
    const oldVolume = orderBook.bids[price] || 0;
    
    if (numVolume === 0) {
      delete orderBook.bids[price];
      // Only record removed levels if they had volume before
      if (oldVolume > 0) {
        changes.push({
          price: parseFloat(price),
          bid_delta: -oldVolume,
          ask_delta: 0,
          is_bid: true
        });
      }
    } else {
      orderBook.bids[price] = numVolume;
      changes.push({
        price: parseFloat(price),
        bid_delta: numVolume - oldVolume,
        ask_delta: 0,
        is_bid: true
      });
    }
  });
  
  // Process ask updates
  message.a.forEach(([price, volume]) => {
    const numVolume = parseFloat(volume);
    const oldVolume = orderBook.asks[price] || 0;
    
    if (numVolume === 0) {
      delete orderBook.asks[price];
      // Only record removed levels if they had volume before
      if (oldVolume > 0) {
        changes.push({
          price: parseFloat(price),
          bid_delta: 0,
          ask_delta: -oldVolume,
          is_bid: false
        });
      }
    } else {
      orderBook.asks[price] = numVolume;
      changes.push({
        price: parseFloat(price),
        bid_delta: 0,
        ask_delta: numVolume - oldVolume,
        is_bid: false
      });
    }
  });
  
  // Store recent changes for analysis and visualization
  if (changes.length > 0) {
    orderBook.priceChanges = [...orderBook.priceChanges, ...changes].slice(-1000);
  }
  
  orderBook.lastUpdateId = message.u;
  orderBook.lastUpdateTime = Date.now();
}

/**
 * Connect to Binance's depth WebSocket with automatic reconnection
 */
function connectWebSocket() {
  const socketUrl = `wss://stream.binance.com:9443/ws/${SYMBOL.toLowerCase()}@depth@100ms`;
  const ws = new WebSocket(socketUrl);
  
  ws.on('open', () => {
    console.log(`Connected to Binance depth WebSocket for ${SYMBOL}.`);
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
    console.warn("WebSocket connection closed. Reconnecting in 2 seconds...");
    setTimeout(connectWebSocket, 2000);
  });
}

/**
 * Fetch current market data (price, 24h volume)
 */
async function fetchMarketData(symbol) {
  try {
    const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
    const data = await response.json();
    return {
      price: parseFloat(data.lastPrice),
      priceChange: parseFloat(data.priceChangePercent),
      volume: parseFloat(data.volume),
      quoteVolume: parseFloat(data.quoteVolume)
    };
  } catch (err) {
    console.error("Error fetching market data:", err);
    return null;
  }
}

/**
 * Calculate metrics for order book analysis
 */
function calculateOrderBookMetrics() {
  // Sort bid prices (descending)
  const bidPrices = Object.keys(orderBook.bids)
    .map(p => parseFloat(p))
    .sort((a, b) => b - a);
    
  // Sort ask prices (ascending)
  const askPrices = Object.keys(orderBook.asks)
    .map(p => parseFloat(p))
    .sort((a, b) => a - b);
    
  if (bidPrices.length === 0 || askPrices.length === 0) {
    return null;
  }
  
  // Best bid and ask
  const bestBid = bidPrices[0];
  const bestAsk = askPrices[0];
  const midPrice = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  
  // Calculate total volumes
  const bidVolume = Object.values(orderBook.bids).reduce((sum, vol) => sum + vol, 0);
  const askVolume = Object.values(orderBook.asks).reduce((sum, vol) => sum + vol, 0);
  
  // Volume imbalance (-1 to 1, positive means more bids than asks)
  const imbalance = bidVolume && askVolume ? 
    (bidVolume - askVolume) / (bidVolume + askVolume) : 0;
  
  return {
    bestBid,
    bestAsk,
    midPrice,
    spread,
    bidVolume,
    askVolume,
    imbalance
  };
}

/**
 * Save a snapshot of the current order book into SQLite with enhanced metrics
 */
async function saveSnapshot() {
  try {
    // Convert bids and asks to sorted arrays for better analysis
    const bidsArray = Object.keys(orderBook.bids)
      .map(price => ({ price: parseFloat(price), volume: orderBook.bids[price] }))
      .sort((a, b) => b.price - a.price)
      .slice(0, MAX_LEVELS); // Limit to configured depth
      
    const asksArray = Object.keys(orderBook.asks)
      .map(price => ({ price: parseFloat(price), volume: orderBook.asks[price] }))
      .sort((a, b) => a.price - b.price)
      .slice(0, MAX_LEVELS); // Limit to configured depth
    
    // Calculate order book metrics
    const metrics = calculateOrderBookMetrics();
    if (!metrics) return;
    
    // Use UTC time with millisecond precision
    const now = new Date();
    const nowStr = formatUTCDate(now);
    
    // Insert snapshot with enhanced metrics
    const sql = `
      INSERT INTO snapshots (
        symbol, timestamp, bids, asks, mid_price, 
        spread, bid_volume, ask_volume, imbalance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    db.run(sql, [
      orderBook.symbol,
      nowStr,
      JSON.stringify(bidsArray),
      JSON.stringify(asksArray),
      metrics.midPrice,
      metrics.spread,
      metrics.bidVolume,
      metrics.askVolume,
      metrics.imbalance
    ], function(err) {
      if (err) {
        console.error("Error saving snapshot:", err);
        return;
      }
      
      // Save price level changes if any
      if (orderBook.priceChanges.length > 0) {
        const snapshotId = this.lastID;
        const changeSql = `
          INSERT INTO price_level_changes (
            snapshot_id, timestamp, price, bid_delta, ask_delta, is_bid
          ) VALUES (?, ?, ?, ?, ?, ?)
        `;
        
        const stmt = db.prepare(changeSql);
        orderBook.priceChanges.forEach(change => {
          stmt.run([
            snapshotId,
            nowStr,
            change.price,
            change.bid_delta,
            change.ask_delta,
            change.is_bid ? 1 : 0
          ]);
        });
        stmt.finalize();
        
        // Clear recorded changes
        orderBook.priceChanges = [];
      }
    });
    
    // Store the current state as previous for next comparison
    orderBook.previousBids = {...orderBook.bids};
    orderBook.previousAsks = {...orderBook.asks};
    
  } catch (err) {
    console.error("Error in saveSnapshot:", err);
  }
}

/**
 * Delete snapshots older than retention days
 */
function deleteOldSnapshots() {
  const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffStr = formatUTCDate(cutoffDate);
  
  // First get IDs of old snapshots
  db.all(`SELECT id FROM snapshots WHERE timestamp < ?`, [cutoffStr], (err, rows) => {
    if (err) {
      console.error("Error finding old snapshots:", err);
      return;
    }
    
    if (rows.length === 0) return;
    
    // Extract IDs
    const ids = rows.map(row => row.id);
    
    // Delete from price_level_changes first (foreign key constraint)
    db.run(`DELETE FROM price_level_changes WHERE snapshot_id IN (${ids.join(',')})`, function(err) {
      if (err) {
        console.error("Error deleting old price changes:", err);
        return;
      }
      
      // Now delete the old snapshots
      db.run(`DELETE FROM snapshots WHERE id IN (${ids.join(',')})`, function(err) {
        if (err) {
          console.error("Error deleting old snapshots:", err);
        } else {
          console.log(`Deleted ${this.changes} snapshots older than ${RETENTION_DAYS} days.`);
        }
      });
    });
  });
}

// ----- Express API Server -----
const app = express();

// CORS Middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

/**
 * Helper: Retrieve enhanced snapshots from SQLite
 */
function getEnhancedSnapshots(symbol, startStr, endStr, interval = null) {
  return new Promise((resolve, reject) => {
    let sql = `SELECT * FROM snapshots WHERE symbol = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp ASC`;
    
    // If interval is specified, select only one row per interval
    if (interval) {
      sql = `
        SELECT s.*
        FROM snapshots s
        JOIN (
          SELECT MIN(id) as id
          FROM snapshots
          WHERE symbol = ? AND timestamp BETWEEN ? AND ?
          GROUP BY strftime('${interval}', timestamp)
        ) i ON s.id = i.id
        ORDER BY s.timestamp ASC
      `;
    }
    
    db.all(sql, [symbol, startStr, endStr], (err, rows) => {
      if (err) {
        return reject(err);
      }
      
      // Parse bids and asks from JSON strings
      const snapshots = rows.map(row => ({
        id: row.id,
        symbol: row.symbol,
        timestamp: row.timestamp,
        bids: JSON.parse(row.bids),
        asks: JSON.parse(row.asks),
        midPrice: row.mid_price,
        spread: row.spread,
        bidVolume: row.bid_volume,
        askVolume: row.ask_volume,
        imbalance: row.imbalance
      }));
      
      resolve(snapshots);
    });
  });
}

/**
 * Endpoint: /api/orderbook/current
 * Returns the current state of the order book
 */
app.get('/api/orderbook/current', (req, res) => {
  const metrics = calculateOrderBookMetrics();
  if (!metrics) {
    return res.status(503).json({ error: "Order book not fully initialized" });
  }
  
  // Sort and limit the number of levels returned
  const maxLevels = parseInt(req.query.levels) || 100;
  
  const bidsArray = Object.keys(orderBook.bids)
    .map(price => ({ price: parseFloat(price), volume: orderBook.bids[price] }))
    .sort((a, b) => b.price - a.price)
    .slice(0, maxLevels);
    
  const asksArray = Object.keys(orderBook.asks)
    .map(price => ({ price: parseFloat(price), volume: orderBook.asks[price] }))
    .sort((a, b) => a.price - b.price)
    .slice(0, maxLevels);
  
  res.json({
    symbol: orderBook.symbol,
    lastUpdateTime: orderBook.lastUpdateTime,
    bids: bidsArray,
    asks: asksArray,
    metrics
  });
});

/**
 * Endpoint: /api/orderbook/ticks
 * Enhanced to provide more detailed tick data with configurable intervals
 */
app.get('/api/orderbook/ticks', async (req, res) => {
  try {
    const symbol = req.query.symbol || SYMBOL;
    const interval = req.query.interval || null; // '%Y-%m-%d %H:%M' for minute grouping
    
    // Parse time range
    const end = req.query.end ? new Date(req.query.end) : new Date();
    const start = req.query.start ? new Date(req.query.start) : new Date(end.getTime() - 60 * 60 * 1000); // Default 1 hour
    
    const startStr = formatUTCDate(start);
    const endStr = formatUTCDate(end);
    
    // Get snapshots, potentially interval-grouped
    const snapshots = await getEnhancedSnapshots(symbol, startStr, endStr, interval);
    
    // Transform into ticks with enhanced metrics
    const ticks = snapshots.map(snapshot => ({
      timestamp: snapshot.timestamp,
      midPrice: snapshot.midPrice,
      spread: snapshot.spread,
      bidVolume: snapshot.bidVolume,
      askVolume: snapshot.askVolume,
      imbalance: snapshot.imbalance,
      bids: snapshot.bids.slice(0, 20), // Top 20 levels for tick display
      asks: snapshot.asks.slice(0, 20)
    }));
    
    res.json(ticks);
  } catch (err) {
    console.error("Error in /api/orderbook/ticks:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * Endpoint: /api/orderbook/heatmap
 * Enhanced heatmap generation with optimized structure for visualization
 */
app.get('/api/orderbook/heatmap', async (req, res) => {
  try {
    const symbol = req.query.symbol || SYMBOL;
    
    // Configurable parameters
    const bucketSize = parseFloat(req.query.bucketSize) || 0.001;
    const maxBuckets = parseInt(req.query.maxBuckets) || 200;
    const timeInterval = req.query.timeInterval; // Optional time grouping
    
    // Time range
    const end = req.query.end ? new Date(req.query.end) : new Date();
    const start = req.query.start ? new Date(req.query.start) : new Date(end.getTime() - 60 * 60 * 1000);
    
    const startStr = formatUTCDate(start);
    const endStr = formatUTCDate(end);
    
    // Get the snapshots
    const snapshots = await getEnhancedSnapshots(symbol, startStr, endStr, timeInterval);
    
    if (snapshots.length === 0) {
      return res.json({ times: [], prices: [], bidVolumes: [], askVolumes: [], cvd: [] });
    }
    
    // Calculate global price range with padding
    let minPrice = Infinity, maxPrice = -Infinity;
    snapshots.forEach(snapshot => {
      if (snapshot.bids.length > 0) {
        minPrice = Math.min(minPrice, snapshot.bids[snapshot.bids.length - 1].price);
      }
      if (snapshot.asks.length > 0) {
        maxPrice = Math.max(maxPrice, snapshot.asks[snapshot.asks.length - 1].price);
      }
    });
    
    // Add padding and ensure we have valid range
    const pricePadding = (maxPrice - minPrice) * 0.1;
    minPrice = Math.max(0, minPrice - pricePadding);
    maxPrice = maxPrice + pricePadding;
    
    // Generate price buckets
    const totalBuckets = Math.min(maxBuckets, Math.ceil((maxPrice - minPrice) / bucketSize));
    const prices = Array.from({ length: totalBuckets }, (_, i) => minPrice + i * bucketSize);
    
    // Initialize output data structures
    const times = snapshots.map(s => s.timestamp);
    const bidVolumes = []; // 2D array [time][price]
    const askVolumes = []; // 2D array [time][price]
    const cvd = []; // Cumulative volume delta for each time
    let cumulativeDelta = 0;
    
    // Process each snapshot
    snapshots.forEach((snapshot, timeIndex) => {
      // Initialize arrays for this time slice
      const bidBuckets = new Array(totalBuckets).fill(0);
      const askBuckets = new Array(totalBuckets).fill(0);
      
      // Aggregate bid volumes into buckets
      snapshot.bids.forEach(order => {
        const bucketIndex = Math.floor((order.price - minPrice) / bucketSize);
        if (bucketIndex >= 0 && bucketIndex < totalBuckets) {
          bidBuckets[bucketIndex] += order.volume;
        }
      });
      
      // Aggregate ask volumes into buckets
      snapshot.asks.forEach(order => {
        const bucketIndex = Math.floor((order.price - minPrice) / bucketSize);
        if (bucketIndex >= 0 && bucketIndex < totalBuckets) {
          askBuckets[bucketIndex] += order.volume;
        }
      });
      
      // Calculate volume delta for this time period
      const periodDelta = snapshot.bidVolume - snapshot.askVolume;
      cumulativeDelta += periodDelta;
      
      bidVolumes.push(bidBuckets);
      askVolumes.push(askBuckets);
      cvd.push(cumulativeDelta);
    });
    
    // Return comprehensive data for heatmap visualization
    res.json({
      symbol,
      times,          // Array of timestamps
      prices,         // Array of price levels (bucket boundaries)
      bidVolumes,     // 2D array of bid volumes [time][price]
      askVolumes,     // 2D array of ask volumes [time][price]
      cvd,            // Cumulative volume delta over time
      minPrice,       // Global min price
      maxPrice,       // Global max price
      bucketSize      // Size of each price bucket
    });
    
  } catch (err) {
    console.error("Error in /api/orderbook/heatmap:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * Endpoint: /api/orderbook/liquidity
 * Provides liquidity analysis at different price levels
 */
app.get('/api/orderbook/liquidity', async (req, res) => {
  try {
    const symbol = req.query.symbol || SYMBOL;
    const depth = parseFloat(req.query.depth) || 0.05; // 5% depth by default
    
    // Get current price
    const metrics = calculateOrderBookMetrics();
    if (!metrics) {
      return res.status(503).json({ error: "Order book not fully initialized" });
    }
    
    const currentPrice = metrics.midPrice;
    const lowerBound = currentPrice * (1 - depth);
    const upperBound = currentPrice * (1 + depth);
    
    // Calculate liquidity in the specified range
    let bidLiquidity = 0;
    let askLiquidity = 0;
    
    // Sum all bid volumes where price >= lowerBound
    Object.keys(orderBook.bids).forEach(price => {
      const numPrice = parseFloat(price);
      if (numPrice >= lowerBound) {
        bidLiquidity += orderBook.bids[price];
      }
    });
    
    // Sum all ask volumes where price <= upperBound
    Object.keys(orderBook.asks).forEach(price => {
      const numPrice = parseFloat(price);
      if (numPrice <= upperBound) {
        askLiquidity += orderBook.asks[price];
      }
    });
    
    // Calculate liquidity ratio
    const liquidityRatio = askLiquidity > 0 ? bidLiquidity / askLiquidity : 999;
    
    res.json({
      symbol,
      currentPrice,
      depth,
      lowerBound,
      upperBound,
      bidLiquidity,
      askLiquidity,
      liquidityRatio,
      imbalance: metrics.imbalance
    });
    
  } catch (err) {
    console.error("Error in /api/orderbook/liquidity:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * Status endpoint
 */
app.get('/', (req, res) => {
  res.send(`Enhanced Orderbook Heatmap Service for ${SYMBOL} is running.`);
});

// ----- Start the Application -----
async function start() {
  try {
    // First, populate the order book
    await fetchInitialOrderBook();
    
    // Connect to Binance WebSocket for live updates
    connectWebSocket();
    
    // Schedule regular snapshots
    setInterval(saveSnapshot, SNAPSHOT_INTERVAL_MS);
    
    // Clean up old data
    setInterval(deleteOldSnapshots, CLEANUP_INTERVAL_MS);
    
    // Create HTTPS server
    const httpsServer = https.createServer(credentials, app);
    httpsServer.listen(PORT, () => {
      console.log(`HTTPS server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Error starting application:", err);
  }
}

start(); 