const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const compression = require('compression');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Rotating log (tees console to a size-capped file) — install early so startup
// + module-load output is captured too.
require('./modules/logger').install();

// Module system
const moduleLoader = require('./modules/loader');
const alertSystem = require('./modules/alert-system');
const metricsExporter = require('./modules/metrics-exporter');

const app = express();
const server = http.createServer(app);
// CORS allowlist: comma-separated ALLOWED_ORIGINS restricts cross-origin access;
// empty = open (back-compat) with a startup warning. Same-origin/non-browser
// requests (no Origin header) are always allowed.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOrigin = allowedOrigins.length ? allowedOrigins : (process.env.CORS_ORIGIN || "*");

const io = socketIo(server, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"]
  }
});

// Middleware
if (allowedOrigins.length) {
    app.use(cors({
        origin: (origin, cb) => (!origin || allowedOrigins.includes(origin))
            ? cb(null, true) : cb(new Error('Not allowed by CORS')),
    }));
    console.log(`[SECURITY] CORS restricted to: ${allowedOrigins.join(', ')}`);
} else {
    app.use(cors());
    console.warn('[SECURITY] CORS open to all origins — set ALLOWED_ORIGINS to restrict');
}
app.use(compression({ 
    level: parseInt(process.env.COMPRESSION_LEVEL) || 2,
    threshold: 1024
}));
app.use(express.json({ limit: '10mb' }));

// Cache static files for better performance
// Serve index.html dynamically with an app.js?v=<mtime> cache-buster so frontend
// deploys reach clients immediately (the static app.js can stay cacheable; the
// versioned URL changes whenever the file changes). Registered before static.
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    try {
        const v = Math.floor(fs.statSync(path.join(__dirname, 'public', 'app.js')).mtimeMs);
        const html = fs.readFileSync(indexPath, 'utf8').replace('src="app.js"', `src="app.js?v=${v}"`);
        res.setHeader('Cache-Control', 'no-cache');
        res.type('html').send(html);
    } catch (e) {
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(indexPath);
    }
});

app.use(express.static('public', {
    maxAge: process.env.STATIC_CACHE_MAXAGE || '1d',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // App shell must always be fresh
            res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
            // Revalidate via ETag every load → cheap 304s, but never stale on deploy
            res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.endsWith('.json')) {
            res.setHeader('Cache-Control', 'public, max-age=300');
        } else if (filePath.endsWith('.svg') || filePath.endsWith('.ico')) {
            res.setHeader('Cache-Control', 'public, max-age=86400');
        }
    }
}));

// Global state - MUST match the frontend expectations exactly
let globalState = {
  flights: [],
  ships: [],
  pizzaIndex: { value: 0, trend: 'stable', lastUpdate: null },
  signals: { eams: [], gpsJamming: [], radioSilence: [] },
  news: [],
  heatSignatures: [],
  cyberIncidents: [],
  alerts: [],
  // Additional data streams
  seismic: { events: [], alerts: [] },
  radiation: { readings: [], anomalies: [], globalStatus: null },
  spaceWeather: { current: null, solarFlares: [], alerts: [] },
  internet: { outages: [], attacks: [], monitoredCountries: {} },
  weather: { locations: [], summary: {}, operationalWindows: [] },
  aiAnalysis: { timestamp: null, situationAssessment: '', tasks: [], threatLevel: 'UNKNOWN' },
  satellite: { lastUpdate: null, wayback: {}, zones: {}, status: 'initializing' },
  offshorePlatforms: { timestamp: null, count: 0, platforms: [], summary: {} },
  submarineCables: { timestamp: null, cableCount: 0, cables: null, landingPoints: null, summary: {} },
  aisVessels: { timestamp: null, count: 0, connected: false, vessels: [], summary: {} },
  ixps: { timestamp: null, count: 0, ixps: [], summary: {} },
  internetHealth: { timestamp: null, healthScore: 100, status: 'unknown', activeIssues: [], cableStatus: [], ixpConnections: [] },
  entitiesOfInterest: { timestamp: null, flights: { count: 0, items: [] }, vessels: { count: 0, items: [] } },
  germanInfrastructure: { timestamp: null, airbases: [], harbours: [], navalBases: [] },
  entityAnalyses: { timestamp: null, recent: [], summary: {} }
};

// Frontend expects specific global state keys - mapping from module names to state keys
const stateKeyMapping = {
  'seismic-monitor': 'seismic',
  'news-aggregator': 'news', 
  'cyber-monitor': 'cyberIncidents',
  'flight-tracker': 'flights',
  'marine-tracker': 'ships',
  'pizza-index': 'pizzaIndex',
  'signals-monitor': 'signals',
  'firms-monitor': 'heatSignatures',
  'space-weather': 'spaceWeather',
  'weather-monitor': 'weather',
  'radiation-monitor': 'radiation',
  'internet-monitor': 'internet',
  'ais-stream': 'aisVessels',
  'offshore-platforms': 'offshorePlatforms',
  'submarine-cables': 'submarineCables',
  'ixp-monitor': 'ixps',
  'internet-health-monitor': 'internetHealth',
  'entity-tracker': 'entitiesOfInterest',
  'overpass-query': 'germanInfrastructure',
  'ollama-entity-analyst': 'entityAnalyses',
  'ollama-analyst': 'aiAnalysis',
  'satellite-imagery': 'satellite'
};

// Frontend expects specific Socket.io event names - mapping from module names to event names  
const socketEventMapping = {
  'seismic-monitor': 'seismic-update',
  'news-aggregator': 'news-update', 
  'cyber-monitor': 'cyber-update',
  'flight-tracker': 'flights-update',
  'marine-tracker': 'marine-update',
  'pizza-index': 'pizza-index-update',
  'signals-monitor': 'signals-update',
  'firms-monitor': 'firms-update',
  'space-weather': 'space-weather-update',
  'weather-monitor': 'weather-update',
  'radiation-monitor': 'radiation-update',
  'internet-monitor': 'internet-update',
  'ais-stream': 'ais-vessels-update',
  'offshore-platforms': 'offshore-platforms-update',
  'submarine-cables': 'submarine-cables-update',
  'ixp-monitor': 'ixp-update',
  'internet-health-monitor': 'internet-health-update',
  'entity-tracker': 'entities-update',
  'overpass-query': 'german-infrastructure-update',
  'ollama-entity-analyst': 'entity-analyses-update',
  'ollama-analyst': 'ai-analysis-update',
  'satellite-imagery': 'satellite-update'
};

// State cleanup to prevent memory leaks
function cleanupGlobalState() {
    for (const [moduleName, moduleData] of Object.entries(globalState)) {
        if (Array.isArray(moduleData.data)) {
            const limit = getDataLimit(moduleName);
            if (moduleData.data.length > limit) {
                moduleData.data = moduleData.data.slice(-limit);
            }
        }
        // Clean up specific large arrays based on module type
        if (moduleData.alerts && moduleData.alerts.length > 100) {
            moduleData.alerts = moduleData.alerts.slice(-100);
        }
        if (moduleData.articles && moduleData.articles.length > 50) {
            moduleData.articles = moduleData.articles.slice(-50);
        }
        if (moduleData.flights && moduleData.flights.length > 200) {
            moduleData.flights = moduleData.flights.slice(-200);
        }
        if (moduleData.ships && moduleData.ships.length > 100) {
            moduleData.ships = moduleData.ships.slice(-100);
        }
        // Maritime layers can grow over days — cap generously (well above normal counts)
        if (moduleData.vessels && moduleData.vessels.length > 5000) {
            moduleData.vessels = moduleData.vessels.slice(-5000);
        }
        if (moduleData.platforms && moduleData.platforms.length > 5000) {
            moduleData.platforms = moduleData.platforms.slice(-5000);
        }
        if (moduleData.cables && Array.isArray(moduleData.cables.features) && moduleData.cables.features.length > 10000) {
            moduleData.cables.features = moduleData.cables.features.slice(-10000);
        }
    }
    
    console.log(`[CLEANUP] State cleaned for ${Object.keys(globalState).length} modules`);
}

function getDataLimit(moduleName) {
    const limits = {
        'news-aggregator': 50,
        'flight-tracker': 200,
        'marine-tracker': 100,
        'cyber-monitor': 20,
        'firms-monitor': 100
    };
    return limits[moduleName] || 50;
}

// Create lightweight state for initial broadcast
function getLightweightState() {
    const lightState = { ...globalState };
    
    // Remove heavy data from initial broadcast but keep the same structure as monolithic version
    const { submarineCables, offshorePlatforms, aisVessels, ...restState } = lightState;
    
    // Add only metadata for maritime (actual data fetched via API with LOD)
    restState.maritimeStatus = {
        platforms: { count: offshorePlatforms?.platforms?.length || 0 },
        cables: { count: submarineCables?.cables?.features?.length || 0 },
        vessels: { count: aisVessels?.vessels?.length || 0, connected: aisVessels?.connected }
    };
    
    return restState;
}

// Socket.io connection with rate limiting
const connectionCounts = new Map();
io.on('connection', (socket) => {
    const clientIP = socket.request.connection.remoteAddress;
    const currentConnections = connectionCounts.get(clientIP) || 0;
    
    if (currentConnections >= 5) {
        console.log(`[SOCKET] Rate limit exceeded for IP: ${clientIP}`);
        socket.disconnect();
        return;
    }
    
    connectionCounts.set(clientIP, currentConnections + 1);
    console.log(`[SOCKET] Client connected: ${socket.id} (IP: ${clientIP})`);
    
    // Send initial state exactly like the monolithic version
    socket.emit('initial-state', getLightweightState());
    socket.emit('module-registry', moduleLoader.getModuleRegistry());
    
    socket.on('disconnect', () => {
        connectionCounts.set(clientIP, Math.max(0, (connectionCounts.get(clientIP) || 1) - 1));
        console.log(`[SOCKET] Client disconnected: ${socket.id}`);
    });
});

// Broadcast updates with JSON size limits
function broadcastUpdate(channel, data) {
    try {
        const jsonString = JSON.stringify(data);
        const sizeKB = Buffer.byteLength(jsonString, 'utf8') / 1024;
        
        if (sizeKB > 500) {
            console.log(`[BROADCAST] Skipping large update: ${channel} (${sizeKB.toFixed(1)}KB)`);
            return;
        }
        
        io.emit(channel, data);
        console.log(`[BROADCAST] ${channel}: ${sizeKB.toFixed(1)}KB`);
    } catch (error) {
        console.error(`[BROADCAST] Error in ${channel}:`, error.message);
    }
}

// Helper function to add alerts with size limits
function addAlert(alert) {
    if (!globalState.alerts) globalState.alerts = [];
    globalState.alerts.push(alert);
    if (globalState.alerts.length > 100) {
        globalState.alerts = globalState.alerts.slice(-100);
    }
    broadcastUpdate('alert', alert);
}

// Update Prometheus metrics after each data update
function updateMetrics() {
    try {
        metricsExporter.updateMetrics(globalState);
    } catch (error) {
        console.error('[METRICS] Error updating metrics:', error.message);
    }
}

// Auto-generate API endpoints from loaded modules
function registerApiEndpoints() {
    const endpoints = moduleLoader.getApiEndpoints();
    
    for (const endpoint of endpoints) {
        app[endpoint.method.toLowerCase()](endpoint.path, endpoint.handler);
        console.log(`[API] ✓ ${endpoint.method} ${endpoint.path}`);
    }
    
    // Module registry endpoint
    app.get('/api/modules', (req, res) => {
        res.json({
            modules: moduleLoader.getModuleRegistry(),
            loaded: moduleLoader.getModules().size,
            timestamp: new Date()
        });
    });

    // Status endpoint that matches the monolithic version exactly
    app.get('/api/status', (req, res) => {
        const loadedModules = moduleLoader.getModules();
        res.json({
            timestamp: new Date(),
            modules: {
                loaded: loadedModules.size,
                enabled: Array.from(loadedModules.values()).filter(m => m.enabled).length
            },
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            environment: {
                node: process.version,
                pid: process.pid
            }
        });
    });

    // State endpoint that returns the complete global state
    app.get('/api/state', (req, res) => {
        res.json(globalState);
    });

    // --- Frontend LOD / layer REST endpoints (paginated) ---
    const paginate = (arr, req) => {
        const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 200, 5000));
        const offset = Math.max(0, parseInt(req.query.offset) || 0);
        const total = arr.length;
        return {
            slice: arr.slice(offset, offset + limit),
            pagination: { total, offset, limit, hasMore: offset + limit < total }
        };
    };

    app.get('/api/maritime/platforms', (req, res) => {
        const { slice, pagination } = paginate(globalState.offshorePlatforms?.platforms || [], req);
        res.json({ platforms: slice, pagination });
    });

    app.get('/api/maritime/cables', (req, res) => {
        const { slice, pagination } = paginate(globalState.submarineCables?.cables?.features || [], req);
        res.json({ cables: { type: 'FeatureCollection', features: slice }, pagination });
    });

    app.get('/api/maritime/vessels', (req, res) => {
        const { slice, pagination } = paginate(globalState.aisVessels?.vessels || [], req);
        res.json({ vessels: slice, pagination });
    });

    app.get('/api/ixp/exchanges', (req, res) => {
        let all = globalState.ixps?.ixps || [];
        const tier = parseInt(req.query.tier);
        if (!isNaN(tier)) all = all.filter(x => x.tier == null || x.tier <= tier);
        const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 200, 5000));
        res.json({ ixps: all.slice(0, limit), count: all.length });
    });

    app.get('/api/internet-health', (req, res) => {
        res.json(globalState.internetHealth || {});
    });

    app.get('/api/satellite/layers', (req, res) => {
        res.json({
            providers: ['esri', 'osm', 'gibs_modis', 'gibs_viirs'],
            zones: globalState.satellite?.zones || {},
            status: globalState.satellite?.status || 'unknown'
        });
    });

    // Clear alerts endpoint
    app.post('/api/alerts/clear', (req, res) => {
        globalState.alerts = [];
        res.json({ success: true });
    });
}

// Health check endpoint
app.get('/health', (req, res) => {
    const loadedModules = moduleLoader.getModules();
    res.json({
        status: 'ok',
        timestamp: new Date(),
        modules: {
            loaded: loadedModules.size,
            enabled: Array.from(loadedModules.values()).filter(m => m.enabled).length
        },
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// Deep per-module health: last-update age, staleness, and error status per module.
// Always 200 (observability endpoint, not a load-balancer liveness gate); the
// `status` field reflects whether any module is in error/stale.
app.get('/healthz', (req, res) => {
    const now = Date.now();
    const modules = {};
    let errors = 0, stale = 0;
    for (const [key, val] of Object.entries(globalState)) {
        if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
        const ts = val.timestamp || val.lastUpdate || null;
        const ageSeconds = ts ? Math.round((now - new Date(ts).getTime()) / 1000) : null;
        const hasError = !!val.error;
        const isStale = ageSeconds != null && ageSeconds > 1800; // >30min without update
        if (hasError) errors++;
        if (isStale) stale++;
        modules[key] = {
            ok: !hasError,
            lastUpdate: ts,
            ageSeconds,
            stale: isStale,
            ...(hasError ? { error: val.error } : {})
        };
    }
    res.json({
        status: errors === 0 ? 'ok' : 'degraded',
        timestamp: new Date(),
        uptime: process.uptime(),
        summary: { modules: Object.keys(modules).length, errors, stale },
        modules
    });
});

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
    try {
        // prom-client v15 register.metrics() is async — must await or the
        // endpoint sends a pending Promise and Prometheus gets nothing.
        const metrics = await metricsExporter.getMetrics();
        res.set('Content-Type', metricsExporter.register?.contentType || 'text/plain');
        res.send(metrics);
    } catch (error) {
        console.error('[METRICS] endpoint error:', error.message);
        res.status(500).send('Error generating metrics');
    }
});

// Cleanup task every hour
cron.schedule('0 * * * *', cleanupGlobalState);

// Custom broadcast function that maps module updates to correct events
function customBroadcast(moduleName, data) {
    // Map module name to correct global state key
    const stateKey = stateKeyMapping[moduleName] || moduleName;
    const eventName = socketEventMapping[moduleName] || `${moduleName}-update`;
    
    // Update global state using the correct key
    if (stateKey in globalState) {
        globalState[stateKey] = data;
    } else {
        globalState[moduleName] = data;
    }
    
    // Broadcast using the correct event name
    broadcastUpdate(eventName, data);
    updateMetrics();
}

// Main initialization
async function initializeServer() {
    try {
        console.log('[SERVER] Starting OSINT Explorer...');
        
        // Load all modules
        await moduleLoader.loadModules();
        
        // Initialize global state with default states but maintain the expected structure
        const moduleDefaults = moduleLoader.getDefaultStates();
        // Don't override the globalState structure, just fill in missing modules
        for (const [moduleName, defaultState] of Object.entries(moduleDefaults)) {
            const stateKey = stateKeyMapping[moduleName] || moduleName;
            if (!globalState[stateKey]) {
                globalState[stateKey] = defaultState;
            }
        }
        
        // Register API endpoints
        registerApiEndpoints();
        
        // Register cron jobs for all modules with proper mapping
        console.log('[MODULE-LOADER] Registering cron jobs...');
        
        const modules = moduleLoader.getModules();
        for (const [moduleName, module] of modules) {
            if (!module.enabled) continue;
            
            const schedule = module.schedule;
            const updateFunction = async () => {
                try {
                    console.log(`[CRON] Updating ${moduleName}...`);
                    const data = await module.update();
                    
                    // Use custom broadcast function for proper mapping
                    customBroadcast(moduleName, data);
                    
                    // Check for alerts — addAlert persists to globalState.alerts AND
                    // broadcasts (broadcastUpdate alone only emitted live, never stored)
                    const alerts = module.getAlerts(data);
                    if (alerts && alerts.length > 0) {
                        for (const alert of alerts) {
                            addAlert(alert);
                        }
                    }
                } catch (error) {
                    console.error(`[CRON] Error updating ${moduleName}:`, error.message);
                    const stateKey = stateKeyMapping[moduleName] || moduleName;
                    globalState[stateKey] = {
                        timestamp: new Date(),
                        error: error.message,
                        module: moduleName
                    };
                }
            };

            cron.schedule(schedule, updateFunction);
            console.log(`[MODULE-LOADER] ✓ Scheduled ${moduleName} (${schedule})`);
        }
        
        // Initial data load
        console.log('[SYSTEM] Loading initial data from all modules...');
        const loadPromises = [];
        
        for (const [moduleName, module] of modules) {
            if (module.enabled) {
                loadPromises.push(
                    module.update()
                        .then(data => {
                            const stateKey = stateKeyMapping[moduleName] || moduleName;
                            globalState[stateKey] = data;
                            // Surface module alerts on initial load too (not just on cron)
                            try {
                                const al = module.getAlerts ? module.getAlerts(data) : null;
                                if (al && al.length) al.forEach(addAlert);
                            } catch (e) { /* module without getAlerts */ }
                            console.log(`[INIT] ✓ ${module.displayName} -> ${stateKey}`);
                        })
                        .catch(error => {
                            const stateKey = stateKeyMapping[moduleName] || moduleName;
                            console.error(`[INIT] ✗ ${module.displayName}: ${error.message}`);
                            globalState[stateKey] = { error: error.message, timestamp: new Date() };
                        })
                );
            }
        }
        
        await Promise.allSettled(loadPromises);
        updateMetrics();
        
        console.log('[SYSTEM] Initial data loaded successfully');
        
    } catch (error) {
        console.error('[SERVER] Initialization failed:', error.message);
        process.exit(1);
    }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[SERVER] OSINT Explorer listening on port ${PORT}`);
});

// Initialize after server starts
initializeServer().catch(console.error);
