/**
 * Base Module Class for OSINT Explorer
 * 
 * All new modules should extend this class to ensure consistent interface
 * and automatic integration with the module loader.
 */

class OsintModule {
  // Module metadata - should be overridden by subclasses
  name = 'unknown';           // unique key for globalState
  displayName = 'Unknown';    // human-readable name
  icon = '📡';                // emoji icon for UI
  category = 'general';       // flights|marine|cyber|geo|infrastructure|intel
  schedule = '*/5 * * * *';   // cron expression for update frequency
  enabled = true;             // whether module is active
  requiresEnv = [];           // array of required env variables

  constructor() {
    // Validate required properties are set by subclass
    if (this.constructor === OsintModule) {
      throw new Error('OsintModule is an abstract class and cannot be instantiated directly');
    }
    
    // Check required environment variables
    this.checkEnvironment();
  }

  /**
   * Check if all required environment variables are present
   * @returns {boolean} true if all env vars are available
   */
  checkEnvironment() {
    const missing = this.requiresEnv.filter(envVar => !process.env[envVar]);
    if (missing.length > 0) {
      console.warn(`[MODULE:${this.name}] Missing required env vars: ${missing.join(', ')}`);
      this.enabled = false;
      return false;
    }
    return true;
  }

  /**
   * Main update method - must be implemented by subclasses
   * @returns {Promise<Object>} data object with timestamp and module-specific data
   */
  async update() {
    throw new Error(`update() method must be implemented by ${this.constructor.name}`);
  }

  /**
   * Get the default/initial state structure for this module
   * @returns {Object} initial state object
   */
  getDefaultState() {
    return {
      timestamp: null,
      count: 0,
      data: [],
      error: null
    };
  }

  /**
   * Generate alerts from module data
   * @param {Object} data - latest module data
   * @returns {Array} array of alert objects
   */
  getAlerts(data) {
    return []; // Override in subclasses that need to generate alerts
  }

  /**
   * Get API endpoint configuration for this module
   * @returns {Object} Express route configuration
   */
  getApiConfig() {
    return {
      path: `/api/${this.name}`,
      method: 'GET',
      handler: async (req, res) => {
        try {
          const data = await this.update();
          res.json(data);
        } catch (error) {
          res.status(500).json({ 
            error: error.message,
            module: this.name,
            timestamp: new Date()
          });
        }
      }
    };
  }

  /**
   * Get Socket.IO event name for this module
   * @returns {string} event name for broadcasts
   */
  getSocketEvent() {
    return `${this.name}-update`;
  }

  /**
   * Validate and sanitize module data before storing/broadcasting
   * @param {Object} data - raw module data
   * @returns {Object} sanitized data
   */
  sanitizeData(data) {
    return {
      ...data,
      timestamp: data.timestamp || new Date(),
      module: this.name
    };
  }

  /**
   * Get module info for frontend registration
   * @returns {Object} module metadata
   */
  getInfo() {
    return {
      name: this.name,
      displayName: this.displayName,
      icon: this.icon,
      category: this.category,
      enabled: this.enabled,
      schedule: this.schedule,
      hasAlerts: this.getAlerts.toString() !== OsintModule.prototype.getAlerts.toString()
    };
  }
}

module.exports = OsintModule;