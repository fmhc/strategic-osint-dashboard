/**
 * Module Auto-Loader for OSINT Explorer
 * 
 * Automatically discovers, loads, and manages all modules in the modules/ directory.
 * Handles both new OsintModule subclasses and legacy modules.
 */

const fs = require('fs');
const path = require('path');
const OsintModule = require('./base-module');

class ModuleLoader {
  constructor() {
    this.modules = new Map();
    this.loadedModules = new Map();
    this.skippedModules = new Map();
  }

  /**
   * Scan and load all modules from the modules directory
   */
  async loadModules() {
    console.log('[MODULE-LOADER] Scanning modules directory...');
    
    const modulesDir = __dirname;
    const files = fs.readdirSync(modulesDir);
    
    // Filter for .js files, exclude special files
    const moduleFiles = files.filter(file => 
      file.endsWith('.js') && 
      !['base-module.js', 'loader.js', 'alert-system.js', 'metrics-exporter.js', 'llm-client.js', 'logger.js'].includes(file)
    );

    console.log(`[MODULE-LOADER] Found ${moduleFiles.length} potential modules`);

    for (const file of moduleFiles) {
      const modulePath = path.join(modulesDir, file);
      const moduleName = path.basename(file, '.js');
      
      try {
        await this.loadModule(moduleName, modulePath);
      } catch (error) {
        console.error(`[MODULE-LOADER] Failed to load ${moduleName}:`, error.message);
        this.skippedModules.set(moduleName, { error: error.message, file });
      }
    }

    console.log(`[MODULE-LOADER] Loaded ${this.modules.size} modules, skipped ${this.skippedModules.size}`);
    this.logLoadResults();
  }

  /**
   * Load a single module and register it
   * @param {string} moduleName - name of the module
   * @param {string} modulePath - path to the module file
   */
  async loadModule(moduleName, modulePath) {
    // Clear require cache to allow reloading
    delete require.cache[require.resolve(modulePath)];
    
    const moduleExport = require(modulePath);
    let moduleInstance = null;

    // Check if it's a new OsintModule subclass
    if (moduleExport instanceof OsintModule) {
      // Direct instance of OsintModule
      moduleInstance = moduleExport;
    } else if (typeof moduleExport === 'function' && moduleExport.prototype instanceof OsintModule) {
      // Class constructor that extends OsintModule
      moduleInstance = new moduleExport();
    } else if (moduleExport.constructor && moduleExport.constructor.prototype instanceof OsintModule) {
      // Already instantiated class that extends OsintModule
      moduleInstance = moduleExport;
    } else {
      // Legacy module - wrap it
      moduleInstance = this.createLegacyWrapper(moduleName, moduleExport);
    }

    // Validate environment requirements
    if (!moduleInstance.checkEnvironment()) {
      this.skippedModules.set(moduleName, { 
        error: `Missing required env vars: ${moduleInstance.requiresEnv.join(', ')}`,
        module: moduleInstance 
      });
      return;
    }

    // Store the loaded module
    this.modules.set(moduleName, moduleInstance);
    this.loadedModules.set(moduleName, {
      instance: moduleInstance,
      type: moduleInstance instanceof OsintModule ? 'modern' : 'legacy',
      info: moduleInstance.getInfo()
    });

    console.log(`[MODULE-LOADER] ✓ ${moduleName} (${moduleInstance.displayName}) - ${moduleInstance.category}`);
  }

  /**
   * Create a legacy wrapper for old-style modules
   * @param {string} moduleName - name of the module
   * @param {Object} moduleExport - the exported module
   * @returns {OsintModule} wrapped module instance
   */
  createLegacyWrapper(moduleName, moduleExport) {
    class LegacyModuleWrapper extends OsintModule {
      constructor(name, legacyModule) {
        super();
        this.name = name;
        this.displayName = this.generateDisplayName(name);
        this.icon = this.detectIcon(name);
        this.category = this.detectCategory(name);
        this.schedule = this.detectSchedule(name);
        this.enabled = true;
        this.requiresEnv = this.detectRequiredEnv(name);
        this.legacyModule = legacyModule;
        this.updateMethod = this.detectUpdateMethod(legacyModule);
      }

      async update() {
        if (!this.updateMethod) {
          throw new Error(`No suitable update method found for legacy module ${this.name}`);
        }
        
        try {
          console.log(`[LEGACY] Calling ${this.updateMethod} for ${this.name}`);
          const data = await this.legacyModule[this.updateMethod]();
          return this.sanitizeData(data);
        } catch (error) {
          return {
            timestamp: new Date(),
            error: error.message,
            module: this.name
          };
        }
      }

      // Delegate to the wrapped module's getAlerts (the OsintModule base default
      // returns [], which silently swallowed alerts from every legacy module).
      getAlerts(data) {
        if (typeof this.legacyModule.getAlerts === 'function') {
          try { return this.legacyModule.getAlerts(data) || []; }
          catch (e) { return []; }
        }
        return [];
      }

      getDefaultState() {
        // Try to infer default state from module name
        switch (this.category) {
          case 'flights':
            return { flights: [], timestamp: null, count: 0 };
          case 'marine':
            return { ships: [], vessels: [], timestamp: null, count: 0 };
          case 'cyber':
            return { incidents: [], timestamp: null, count: 0 };
          case 'geo':
            return { events: [], timestamp: null, count: 0 };
          default:
            return { data: [], timestamp: null, count: 0 };
        }
      }

      detectUpdateMethod(module) {
        // Try common method names in order of specificity
        const methodNames = [
          // Specific known method names first
          'monitorSeismicActivity', 'aggregateNews', 'monitorCyberspace',
          'trackVessels', 'getStrategicFlights', 'calculateIndex',
          'monitorSignals', 'getHeatSignatures', 'trackAISVessels',
          'getStatus', 'getExchanges', 'getInfrastructure', 'getState',
          'getPlatforms', 'getCables', 'getLocations',
          'getCurrentWeather', 'getSpaceWeather', 'getRadiationData',
          'getInternetHealth', 'getOutages', 'getImagery', 'getLayers',
          'trackEntities', 'getEntities', 'performAnalysis',
          // Actual method names used by several modules (were stuck in error-state)
          'monitorWeather', 'monitorSpaceWeather', 'monitorRadiation',
          'monitorInternet', 'updateSatelliteData', 'refreshAll', 'getHealthStatus',
          'getVessels', 'getTrackedEntities',
          // Generic fallbacks
          'update', 'fetch', 'get', 'monitor', 'track'
        ];

        for (const method of methodNames) {
          // Check both on instance and prototype
          if (typeof module[method] === 'function' || 
              (module.constructor && typeof module.constructor.prototype[method] === 'function')) {
            console.log(`[MODULE-LOADER] Found update method ${method} for ${this.name}`);
            return method;
          }
        }
        
        // Also check all methods on the prototype
        if (module.constructor && module.constructor.prototype) {
          const protoMethods = Object.getOwnPropertyNames(module.constructor.prototype);
          console.log(`[MODULE-LOADER] Available methods for ${this.name}:`, protoMethods.filter(m => typeof module[m] === 'function'));
        }
        
        return null;
      }

      generateDisplayName(name) {
        return name
          .split('-')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
      }

      detectIcon(name) {
        const iconMap = {
          'flight': '✈️', 'marine': '🚢', 'seismic': '🌋', 'weather': '🌤️',
          'cyber': '💻', 'news': '📰', 'pizza': '🍕', 'signals': '📡',
          'radiation': '☢️', 'space': '🌌', 'satellite': '🛰️', 'firms': '🔥',
          'internet': '🌐', 'ais': '📍', 'submarine': '⚓', 'offshore': '🛢️',
          'entity': '🎯', 'ollama': '🤖', 'overpass': '🗺️', 'ixp': '🔗'
        };
        
        for (const [key, icon] of Object.entries(iconMap)) {
          if (name.includes(key)) return icon;
        }
        return '📊';
      }

      detectCategory(name) {
        const categoryMap = {
          'flight': 'flights', 'marine': 'marine', 'ais': 'marine',
          'submarine': 'marine', 'offshore': 'marine',
          'seismic': 'geo', 'weather': 'geo', 'satellite': 'geo',
          'cyber': 'cyber', 'internet': 'cyber',
          'news': 'intel', 'signals': 'intel', 'entity': 'intel',
          'radiation': 'infrastructure', 'space': 'infrastructure',
          'ixp': 'infrastructure', 'overpass': 'infrastructure'
        };
        
        for (const [key, category] of Object.entries(categoryMap)) {
          if (name.includes(key)) return category;
        }
        return 'general';
      }

      detectSchedule(name) {
        // Different update frequencies based on module type
        const scheduleMap = {
          'flight': '*/5 * * * *',    // Every 5 minutes (~288/day, under OpenSky free 400/day)
          'marine': '*/5 * * * *',    // Every 5 minutes
          'news': '*/3 * * * *',      // Every 3 minutes
          'cyber': '*/5 * * * *',     // Every 5 minutes
          'signals': '*/1 * * * *',   // Every minute
          'seismic': '*/3 * * * *',   // Every 3 minutes
          'pizza': '*/10 * * * *',    // Every 10 minutes
          'weather': '*/15 * * * *',  // Every 15 minutes
          'satellite': '*/30 * * * *', // Every 30 minutes
          'ollama': '*/20 * * * *'    // Every 20 minutes
        };
        
        for (const [key, schedule] of Object.entries(scheduleMap)) {
          if (name.includes(key)) return schedule;
        }
        return '*/5 * * * *'; // Default: every 5 minutes
      }

      detectRequiredEnv(name) {
        const envMap = {
          'ais-stream': ['AISSTREAM_API_KEY'],
          'ollama': ['OLLAMA_ENABLED'],
          'satellite': ['SATELLITE_API_KEY'],
          'weather': ['WEATHER_API_KEY']
        };
        
        return envMap[name] || [];
      }
    }

    return new LegacyModuleWrapper(moduleName, moduleExport);
  }

  /**
   * Get all loaded modules
   * @returns {Map} Map of module name -> module instance
   */
  getModules() {
    return this.modules;
  }

  /**
   * Get a specific module by name
   * @param {string} name - module name
   * @returns {OsintModule|null} module instance or null
   */
  getModule(name) {
    return this.modules.get(name) || null;
  }

  /**
   * Get default states for all modules
   * @returns {Object} object with module states
   */
  getDefaultStates() {
    const states = {};
    for (const [name, module] of this.modules) {
      states[name] = module.getDefaultState();
    }
    return states;
  }

  /**
   * Register cron jobs for all modules
   * @param {Object} cron - node-cron instance
   * @param {Object} globalState - global state object
   * @param {Function} broadcastFn - function to broadcast updates
   */
  registerCronJobs(cron, globalState, broadcastFn) {
    console.log('[MODULE-LOADER] Registering cron jobs...');
    
    for (const [name, module] of this.modules) {
      if (!module.enabled) continue;
      
      const schedule = module.schedule;
      const updateFunction = async () => {
        try {
          console.log(`[CRON] Updating ${name}...`);
          const data = await module.update();
          
          // Update global state
          globalState[name] = data;
          
          // Broadcast to clients
          broadcastFn(module.getSocketEvent(), data);
          
          // Check for alerts
          const alerts = module.getAlerts(data);
          if (alerts && alerts.length > 0) {
            for (const alert of alerts) {
              broadcastFn('alert', alert);
            }
          }
        } catch (error) {
          console.error(`[CRON] Error updating ${name}:`, error.message);
          globalState[name] = {
            timestamp: new Date(),
            error: error.message,
            module: name
          };
        }
      };

      cron.schedule(schedule, updateFunction);
      console.log(`[MODULE-LOADER] ✓ Scheduled ${name} (${schedule})`);
    }
  }

  /**
   * Generate API endpoint configurations for all modules
   * @returns {Array} array of endpoint configurations
   */
  getApiEndpoints() {
    const endpoints = [];
    for (const [name, module] of this.modules) {
      endpoints.push(module.getApiConfig());
    }
    return endpoints;
  }

  /**
   * Get module registry for frontend
   * @returns {Array} array of module info objects
   */
  getModuleRegistry() {
    return Array.from(this.modules.values()).map(module => module.getInfo());
  }

  /**
   * Log loading results
   */
  logLoadResults() {
    console.log('\n[MODULE-LOADER] === LOADING SUMMARY ===');
    console.log(`✓ Successfully loaded: ${this.modules.size} modules`);
    
    if (this.modules.size > 0) {
      const byCategory = {};
      for (const module of this.modules.values()) {
        byCategory[module.category] = (byCategory[module.category] || 0) + 1;
      }
      console.log('By category:', byCategory);
    }

    if (this.skippedModules.size > 0) {
      console.log(`⚠️  Skipped: ${this.skippedModules.size} modules`);
      for (const [name, info] of this.skippedModules) {
        console.log(`   ${name}: ${info.error}`);
      }
    }
    console.log('=====================================\n');
  }
}

module.exports = new ModuleLoader();
