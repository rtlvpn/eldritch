/**
 * Advanced Order Book Heatmap Visualization
 * 
 * Features:
 * - Real-time and historical order book heatmap
 * - Integrated price chart
 * - Order book depth visualization
 * - Market liquidity analysis
 * - Cumulative Volume Delta (CVD) indicator
 * - High-performance canvas rendering
 * 
 * Libraries: D3.js, Luxon
 */

// API Endpoint - Change to your server URL
const API_ENDPOINT = 'https://eldritch.gleeze.com:3500'; 

// Global state
const state = {
  symbol: 'TRXUSDT',
  heatmapData: null,
  ticksData: null,
  currentOrderBook: null,
  timeRange: 60, // minutes
  bucketSize: 0.001,
  maxBuckets: 200,
  colorIntensity: 1,
  autoRefresh: 2000, // ms
  showPriceLine: true,
  showCVD: true,
  showCrosshair: true,
  refreshInterval: null,
  heatmapCanvas: null,
  heatmapCtx: null,
  priceScale: null,
  timeScale: null,
  canvasWidth: 0,
  canvasHeight: 0,
  crosshairX: 0,
  crosshairY: 0,
  mouseInCanvas: false
};

// Initialize the application
function initApp() {
  // Set up canvas
  state.heatmapCanvas = document.getElementById('heatmap-canvas');
  state.heatmapCtx = state.heatmapCanvas.getContext('2d');
  
  // Set up event listeners
  document.getElementById('symbol-picker').addEventListener('change', handleSymbolChange);
  document.querySelectorAll('.time-button').forEach(btn => {
    btn.addEventListener('click', handleTimeRangeChange);
  });
  document.getElementById('auto-refresh').addEventListener('change', handleAutoRefreshChange);
  document.getElementById('bucket-size').addEventListener('change', handleSettingsChange);
  document.getElementById('max-buckets').addEventListener('change', handleSettingsChange);
  document.getElementById('color-intensity').addEventListener('input', handleSettingsChange);
  document.getElementById('show-price-line').addEventListener('change', handleDisplayOptionChange);
  document.getElementById('show-cvd').addEventListener('change', handleDisplayOptionChange);
  document.getElementById('show-crosshair').addEventListener('change', handleDisplayOptionChange);
  
  // Set up canvas mouse events for tooltips and crosshair
  setupCanvasInteractions();
  
  // Handle window resize
  window.addEventListener('resize', handleResize);
  handleResize();
  
  // Initial data fetch
  refreshData();
  
  // Set up auto-refresh
  setupAutoRefresh();
}

// Setup canvas interactions
function setupCanvasInteractions() {
  const heatmapContainer = document.getElementById('heatmap-container');
  const tooltip = document.getElementById('heatmap-tooltip');
  const crosshairX = document.getElementById('crosshair-x');
  const crosshairY = document.getElementById('crosshair-y');
  const priceLabel = document.getElementById('crosshair-price-label');
  const timeLabel = document.getElementById('crosshair-time-label');
  
  heatmapContainer.addEventListener('mousemove', (e) => {
    if (!state.heatmapData) return;
    
    const containerRect = heatmapContainer.getBoundingClientRect();
    // Account for orderbook panel width
    const orderbookWidth = document.getElementById('orderbook-panel').offsetWidth;
    const effectiveWidth = containerRect.width - orderbookWidth;
    
    const x = e.clientX - containerRect.left;
    const y = e.clientY - containerRect.top;
    
    // Don't process if mouse is over orderbook panel
    if (x > effectiveWidth) {
      if (state.mouseInCanvas) {
        state.mouseInCanvas = false;
        hideTooltipAndCrosshair();
      }
      return;
    }
    
    state.mouseInCanvas = true;
    state.crosshairX = x;
    state.crosshairY = y;
    
    if (state.showCrosshair) {
      // Position crosshair lines
      crosshairX.style.display = 'block';
      crosshairY.style.display = 'block';
      crosshairX.style.top = `${y}px`;
      crosshairX.style.width = `${effectiveWidth}px`;
      crosshairY.style.left = `${x}px`;
      crosshairY.style.height = `${containerRect.height}px`;
      
      // Calculate price and time at cursor position
      if (state.timeScale && state.priceScale) {
        const price = state.priceScale.invert(y);
        const timeIndex = Math.floor(state.timeScale(x));
        
        // Place price label
        priceLabel.style.display = 'block';
        priceLabel.style.top = `${y - 10}px`;
        priceLabel.style.left = `${effectiveWidth + 5}px`;
        priceLabel.textContent = price.toFixed(5);
        
        // Place time label
        if (timeIndex >= 0 && timeIndex < state.heatmapData.times.length) {
          const time = state.heatmapData.times[timeIndex];
          const dateTime = luxon.DateTime.fromISO(time.replace(' ', 'T') + 'Z');
          
          timeLabel.style.display = 'block';
          timeLabel.style.left = `${x - 40}px`;
          timeLabel.style.top = `${containerRect.height - 20}px`;
          timeLabel.textContent = dateTime.toFormat('HH:mm:ss');
        }
      }
      
      // Show tooltip with volume info
      showHeatmapTooltip(x, y, effectiveWidth);
    }
  });
  
  heatmapContainer.addEventListener('mouseleave', () => {
    state.mouseInCanvas = false;
    hideTooltipAndCrosshair();
  });
  
  function hideTooltipAndCrosshair() {
    tooltip.style.display = 'none';
    crosshairX.style.display = 'none';
    crosshairY.style.display = 'none';
    priceLabel.style.display = 'none';
    timeLabel.style.display = 'none';
  }
}

// Show tooltip with volume information
function showHeatmapTooltip(x, y, effectiveWidth) {
  if (!state.heatmapData || !state.showCrosshair) return;
  
  const tooltip = document.getElementById('heatmap-tooltip');
  
  // Calculate data point indexes
  const timeIndex = Math.floor(state.timeScale(x));
  const priceIndex = Math.floor(state.priceScale.invert(y) / state.heatmapData.bucketSize) - 
                     Math.floor(state.heatmapData.minPrice / state.heatmapData.bucketSize);
  
  // Ensure indexes are valid
  if (timeIndex < 0 || timeIndex >= state.heatmapData.times.length ||
      priceIndex < 0 || priceIndex >= state.heatmapData.prices.length) {
    tooltip.style.display = 'none';
    return;
  }
  
  // Get volumes at this point
  const bidVolume = state.heatmapData.bidVolumes[timeIndex][priceIndex] || 0;
  const askVolume = state.heatmapData.askVolumes[timeIndex][priceIndex] || 0;
  const price = state.heatmapData.prices[priceIndex];
  
  // Format tooltip content
  tooltip.innerHTML = `
    <div><strong>Price:</strong> ${price.toFixed(5)}</div>
    <div style="color: var(--bid-color);"><strong>Bid Vol:</strong> ${bidVolume.toFixed(4)}</div>
    <div style="color: var(--ask-color);"><strong>Ask Vol:</strong> ${askVolume.toFixed(4)}</div>
    <div><strong>Ratio:</strong> ${bidVolume > 0 && askVolume > 0 ? (bidVolume / askVolume).toFixed(2) : 'N/A'}</div>
  `;
  
  // Position tooltip
  const tooltipRect = tooltip.getBoundingClientRect();
  const container = document.getElementById('heatmap-container');
  const containerRect = container.getBoundingClientRect();
  
  let tooltipX = x + 15;
  let tooltipY = y + 15;
  
  // Ensure tooltip stays within container
  if (tooltipX + tooltipRect.width > effectiveWidth) {
    tooltipX = x - tooltipRect.width - 15;
  }
  
  if (tooltipY + tooltipRect.height > containerRect.height) {
    tooltipY = y - tooltipRect.height - 15;
  }
  
  tooltip.style.left = `${tooltipX}px`;
  tooltip.style.top = `${tooltipY}px`;
  tooltip.style.display = 'block';
}

// Handle window resize event
function handleResize() {
  const container = document.getElementById('heatmap-container');
  const canvas = state.heatmapCanvas;
  
  // Set canvas size to match container
  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  
  // Subtract order book panel width for better visualization
  const orderbookWidth = document.getElementById('orderbook-panel').offsetWidth;
  state.canvasWidth = (rect.width - orderbookWidth) * dpr;
  state.canvasHeight = rect.height * dpr;
  
  canvas.width = state.canvasWidth;
  canvas.height = state.canvasHeight;
  
  // Scale canvas style
  canvas.style.width = `${rect.width - orderbookWidth}px`;
  canvas.style.height = `${rect.height}px`;
  
  // Scale drawing context
  state.heatmapCtx.scale(dpr, dpr);
  
  // Re-render if we have data
  if (state.heatmapData) {
    renderHeatmap();
  }
  
  if (state.ticksData) {
    renderPriceChart();
  }
}

// Handle symbol change
function handleSymbolChange(e) {
  state.symbol = e.target.value;
  refreshData();
}

// Handle time range change
function handleTimeRangeChange(e) {
  // Update active button
  document.querySelectorAll('.time-button').forEach(btn => {
    btn.classList.remove('active');
  });
  e.target.classList.add('active');
  
  // Update state
  state.timeRange = parseInt(e.target.dataset.minutes);
  refreshData();
}

// Handle auto refresh change
function handleAutoRefreshChange(e) {
  const value = e.target.value;
  
  // Clear existing interval
  if (state.refreshInterval) {
    clearInterval(state.refreshInterval);
    state.refreshInterval = null;
  }
  
  if (value !== 'none') {
    state.autoRefresh = parseInt(value);
    setupAutoRefresh();
  } else {
    state.autoRefresh = null;
  }
}

// Handle settings change
function handleSettingsChange(e) {
  const id = e.target.id;
  
  if (id === 'bucket-size') {
    state.bucketSize = parseFloat(e.target.value);
  } else if (id === 'max-buckets') {
    state.maxBuckets = parseInt(e.target.value);
  } else if (id === 'color-intensity') {
    state.colorIntensity = parseFloat(e.target.value);
  }
  
  refreshData();
}

// Handle display option changes
function handleDisplayOptionChange(e) {
  const id = e.target.id;
  
  if (id === 'show-price-line') {
    state.showPriceLine = e.target.checked;
  } else if (id === 'show-cvd') {
    state.showCVD = e.target.checked;
  } else if (id === 'show-crosshair') {
    state.showCrosshair = e.target.checked;
    
    // Hide crosshair elements if disabled
    if (!state.showCrosshair) {
      document.getElementById('crosshair-x').style.display = 'none';
      document.getElementById('crosshair-y').style.display = 'none';
      document.getElementById('crosshair-price-label').style.display = 'none';
      document.getElementById('crosshair-time-label').style.display = 'none';
      document.getElementById('heatmap-tooltip').style.display = 'none';
    }
  }
  
  // Re-render with current data
  renderHeatmap();
  renderPriceChart();
}

// Set up auto refresh
function setupAutoRefresh() {
  if (state.autoRefresh) {
    state.refreshInterval = setInterval(() => {
      fetchCurrentOrderBook();
    }, state.autoRefresh);
  }
}

// Refresh all data
async function refreshData() {
  try {
    // Show loading indicators
    document.getElementById('heatmap-loading').style.display = 'flex';
    document.getElementById('price-loading').style.display = 'flex';
    
    // Update connection status
    updateConnectionStatus('loading');
    
    // Set API requests
    const requests = [
      fetchHeatmapData(),
      fetchTicksData(),
      fetchCurrentOrderBook()
    ];
    
    // Wait for all requests to complete
    await Promise.all(requests);
    
    // Hide loading indicators
    document.getElementById('heatmap-loading').style.display = 'none';
    document.getElementById('price-loading').style.display = 'none';
    
    // Update connection status
    updateConnectionStatus('connected');
  } catch (error) {
    console.error('Error refreshing data:', error);
    updateConnectionStatus('disconnected');
    
    // Hide loading indicators
    document.getElementById('heatmap-loading').style.display = 'none';
    document.getElementById('price-loading').style.display = 'none';
  }
}

// Fetch heatmap data
async function fetchHeatmapData() {
  try {
    // Calculate time range
    const end = new Date();
    const start = new Date(end.getTime() - state.timeRange * 60 * 1000);
    
    // Format parameters
    const params = new URLSearchParams({
      symbol: state.symbol,
      start: start.toISOString(),
      end: end.toISOString(),
      bucketSize: state.bucketSize,
      maxBuckets: state.maxBuckets
    });
    
    // Fetch data
    const response = await fetch(`${API_ENDPOINT}/api/orderbook/heatmap?${params}`);
    
    if (!response.ok) {
      throw new Error(`API returned status ${response.status}`);
    }
    
    state.heatmapData = await response.json();
    renderHeatmap();
    
    return state.heatmapData;
  } catch (error) {
    console.error('Error fetching heatmap data:', error);
    throw error;
  }
}

// Fetch price ticks data
async function fetchTicksData() {
  try {
    // Calculate time range
    const end = new Date();
    const start = new Date(end.getTime() - state.timeRange * 60 * 1000);
    
    // Calculate appropriate interval based on time range
    let interval = '%Y-%m-%d %H:%M:%S';
    if (state.timeRange >= 1440) { // 1 day or more
      interval = '%Y-%m-%d %H:%M:%S';
    } else if (state.timeRange >= 360) { // 6 hours or more
      interval = '%Y-%m-%d %H:%M:%S';
    }
    
    // Format parameters
    const params = new URLSearchParams({
      symbol: state.symbol,
      start: start.toISOString(),
      end: end.toISOString(),
      interval: interval
    });
    
    // Fetch data
    const response = await fetch(`${API_ENDPOINT}/api/orderbook/ticks?${params}`);
    
    if (!response.ok) {
      throw new Error(`API returned status ${response.status}`);
    }
    
    state.ticksData = await response.json();
    renderPriceChart();
    
    return state.ticksData;
  } catch (error) {
    console.error('Error fetching ticks data:', error);
    throw error;
  }
}

// Fetch current order book
async function fetchCurrentOrderBook() {
  try {
    // Format parameters
    const params = new URLSearchParams({
      symbol: state.symbol,
      levels: 100 // Number of price levels to fetch
    });
    
    // Fetch data
    const response = await fetch(`${API_ENDPOINT}/api/orderbook/current?${params}`);
    
    if (!response.ok) {
      throw new Error(`API returned status ${response.status}`);
    }
    
    state.currentOrderBook = await response.json();
    updateStatistics();
    renderOrderBook();
    
    return state.currentOrderBook;
  } catch (error) {
    console.error('Error fetching current order book:', error);
    throw error;
  }
}

// Update connection status indicator
function updateConnectionStatus(status) {
  const statusDot = document.getElementById('connection-status');
  const statusText = document.getElementById('status-text');
  
  statusDot.className = 'status-dot';
  
  if (status === 'connected') {
    statusDot.classList.add('connected');
    statusText.textContent = 'Connected';
  } else if (status === 'disconnected') {
    statusDot.classList.add('disconnected');
    statusText.textContent = 'Disconnected';
  } else if (status === 'loading') {
    statusDot.classList.add('loading');
    statusText.textContent = 'Loading...';
  }
}

// Update statistics display
function updateStatistics() {
  if (!state.currentOrderBook || !state.currentOrderBook.metrics) return;
  
  const metrics = state.currentOrderBook.metrics;
  
  // Update price
  document.getElementById('price-value').textContent = 
    metrics.midPrice.toFixed(5);
  
  // Update spread
  document.getElementById('spread-value').textContent = 
    metrics.spread.toFixed(5);
  
  // Update imbalance
  const imbalance = metrics.imbalance;
  const imbalanceEl = document.getElementById('imbalance-value');
  imbalanceEl.textContent = (imbalance * 100).toFixed(2) + '%';
  imbalanceEl.style.color = imbalance > 0 ? 'var(--bid-color)' : 'var(--ask-color)';
  
  // Update order book spread
  document.getElementById('ob-spread-value').textContent = 
    metrics.spread.toFixed(5);
}

// Render the order book side panel
function renderOrderBook() {
    if (!state.currentOrderBook) return;
    
    const bidsContainer = document.getElementById('orderbook-bids');
    const asksContainer = document.getElementById('orderbook-asks');
    
    // Clear previous content
    bidsContainer.innerHTML = '';
    asksContainer.innerHTML = '';
    
    // Get the order book data
    const { bids, asks } = state.currentOrderBook;
    
    // Find max volume for visual scaling
    const maxVolume = Math.max(
      ...bids.map(bid => bid.volume),
      ...asks.map(ask => ask.volume)
    );
    
    // Render bids (buy orders)
    bids.forEach(bid => {
      const levelEl = document.createElement('div');
      levelEl.className = 'orderbook-level';
      
      const barWidth = (bid.volume / maxVolume) * 100;
      
      levelEl.innerHTML = `
        <div class="orderbook-price bid">${bid.price.toFixed(5)}</div>
        <div class="orderbook-volume">${bid.volume.toFixed(4)}</div>
        <div class="orderbook-bar bid-bar" style="width: ${barWidth}%"></div>
      `;
      
      bidsContainer.appendChild(levelEl);
    });
    
    // Render asks (sell orders)
    asks.forEach(ask => {
      const levelEl = document.createElement('div');
      levelEl.className = 'orderbook-level';
      
      const barWidth = (ask.volume / maxVolume) * 100;
      
      levelEl.innerHTML = `
        <div class="orderbook-price ask">${ask.price.toFixed(5)}</div>
        <div class="orderbook-volume">${ask.volume.toFixed(4)}</div>
        <div class="orderbook-bar ask-bar" style="width: ${barWidth}%"></div>
      `;
      
      asksContainer.appendChild(levelEl);
    });
  }
  
  // Render the price chart using D3.js
  function renderPriceChart() {
    if (!state.ticksData || state.ticksData.length === 0) return;
    
    // Select the SVG element
    const svg = d3.select('#price-chart-svg');
    
    // Clear previous content
    svg.selectAll('*').remove();
    
    // Set dimensions
    const margin = { top: 10, right: 50, bottom: 30, left: 50 };
    const width = svg.node().clientWidth - margin.left - margin.right;
    const height = svg.node().clientHeight - margin.top - margin.bottom;
    
    // Create the main group element
    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);
    
    // Parse dates and prepare data
    const parseTime = luxon.DateTime.fromISO;
    const data = state.ticksData.map(d => ({
      ...d,
      parsedTime: parseTime(d.timestamp.replace(' ', 'T') + 'Z')
    }));
    
    // Create scales
    const xScale = d3.scaleTime()
      .domain(d3.extent(data, d => d.parsedTime.toJSDate()))
      .range([0, width]);
    
    // Determine min and max price with padding
    const minPrice = d3.min(data, d => d.midPrice) * 0.998;
    const maxPrice = d3.max(data, d => d.midPrice) * 1.002;
    
    const yScale = d3.scaleLinear()
      .domain([minPrice, maxPrice])
      .range([height, 0]);
    
    // Create canvas for heatmap background (for performance)
    const heatmapCanvas = document.createElement('canvas');
    heatmapCanvas.width = width;
    heatmapCanvas.height = height;
    const ctx = heatmapCanvas.getContext('2d');
    
    // Render heatmap on canvas if we have the data
    if (state.heatmapData) {
      // Create time scale that matches our xScale
      const heatmapTimeScale = d3.scaleLinear()
        .domain([0, state.heatmapData.times.length - 1])
        .range([0, width]);
      
      // Create price scale that matches our yScale
      const heatmapPriceScale = d3.scaleLinear()
        .domain([state.heatmapData.minPrice, state.heatmapData.maxPrice])
        .range([height, 0]);
      
      // Find max volume for color scaling
      let maxBidVolume = 0;
      let maxAskVolume = 0;
      
      state.heatmapData.bidVolumes.forEach(row => {
        maxBidVolume = Math.max(maxBidVolume, ...row);
      });
      
      state.heatmapData.askVolumes.forEach(row => {
        maxAskVolume = Math.max(maxAskVolume, ...row);
      });
      
      // Apply color intensity factor
      maxBidVolume = maxBidVolume / state.colorIntensity;
      maxAskVolume = maxAskVolume / state.colorIntensity;
      
      // Create color scales - using golden/blue for TensorCharts look
      const bidColorScale = d3.scaleSequential()
        .domain([0, maxBidVolume])
        .interpolator(t => {
          // Gold/amber glow for bids
          return t === 0 ? 'rgba(30, 20, 0, 0)' : d3.interpolateRgb(
            'rgba(50, 40, 0, 0.7)',
            'rgba(255, 200, 0, 0.8)'
          )(t);
        });
      
      const askColorScale = d3.scaleSequential()
        .domain([0, maxAskVolume])
        .interpolator(t => {
          // Blue glow for asks
          return t === 0 ? 'rgba(0, 10, 30, 0)' : d3.interpolateRgb(
            'rgba(0, 20, 50, 0.7)',
            'rgba(0, 120, 255, 0.8)'
          )(t);
        });
      
      // Calculate cell dimensions
      const cellWidth = width / state.heatmapData.times.length;
      const cellHeight = height / state.heatmapData.prices.length;
      
      // Render cells
      for (let timeIdx = 0; timeIdx < state.heatmapData.times.length; timeIdx++) {
        for (let priceIdx = 0; priceIdx < state.heatmapData.prices.length; priceIdx++) {
          const bidVolume = state.heatmapData.bidVolumes[timeIdx][priceIdx] || 0;
          const askVolume = state.heatmapData.askVolumes[timeIdx][priceIdx] || 0;
          
          // Skip if no volume
          if (bidVolume === 0 && askVolume === 0) continue;
          
          // Determine which side to show based on higher volume
          let color;
          if (bidVolume > askVolume) {
            color = bidColorScale(bidVolume);
          } else {
            color = askColorScale(askVolume);
          }
          
          // Calculate position
          const x = heatmapTimeScale(timeIdx);
          const y = heatmapPriceScale(state.heatmapData.prices[priceIdx]);
          
          // Draw rectangle
          ctx.fillStyle = color;
          ctx.fillRect(x, y, cellWidth + 1, cellHeight + 1);
        }
      }
      
      // Convert canvas to image and add to SVG
      const canvasUrl = heatmapCanvas.toDataURL();
      g.append('image')
        .attr('href', canvasUrl)
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', width)
        .attr('height', height);
    }
    
    // Add grid lines
    g.append('g')
      .attr('class', 'grid x-grid')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(xScale)
        .tickSize(-height)
        .tickFormat('')
      )
      .selectAll('line')
      .attr('stroke', 'var(--grid-color)');
    
    g.append('g')
      .attr('class', 'grid y-grid')
      .call(d3.axisLeft(yScale)
        .tickSize(-width)
        .tickFormat('')
      )
      .selectAll('line')
      .attr('stroke', 'var(--grid-color)');
    
    // Add price line
    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', 'white')  // Make price line white to stand out against heatmap
      .attr('stroke-width', 2)
      .attr('d', d3.line()
        .x(d => xScale(d.parsedTime.toJSDate()))
        .y(d => yScale(d.midPrice))
        .curve(d3.curveMonotoneX));
    
    // Add axes
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(xScale)
        .ticks(5)
        .tickFormat(d => luxon.DateTime.fromJSDate(d).toFormat('HH:mm:ss')))
      .selectAll('text')
      .attr('fill', 'var(--text-dim)');
    
    g.append('g')
      .call(d3.axisLeft(yScale)
        .ticks(5)
        .tickFormat(d => d.toFixed(5)))
      .selectAll('text')
      .attr('fill', 'var(--text-dim)');
    
    // Add right y-axis for current price
    g.append('g')
      .attr('transform', `translate(${width},0)`)
      .call(d3.axisRight(yScale)
        .ticks(5)
        .tickFormat(d => d.toFixed(5)))
      .selectAll('text')
      .attr('fill', 'var(--text-dim)');
  }
  
  // Update renderHeatmap to just store the data - actual rendering happens in price chart
  function renderHeatmap() {
    // Just make sure heatmap data is available for the price chart integration
    if (state.heatmapData && state.ticksData) {
      renderPriceChart(); // Re-render price chart with heatmap overlay
    }
  }
  
  // Initialize app on load
  document.addEventListener('DOMContentLoaded', initApp);