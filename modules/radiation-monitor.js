const axios = require('axios');

/**
 * Radiation Monitor Module
 * 
 * Monitors global radiation levels from citizen science networks
 * Useful for: Nuclear incidents, dirty bombs, reactor accidents, nuclear detonations
 * 
 * FREE Data Sources:
 * - Radmon.org (Global citizen Geiger counter network)
 * - Safecast (Open radiation data)
 * - GMCMap (Geiger counter network)
 * - EURDEP (European radiation data - limited public access)
 */

// Normal background radiation levels (µSv/h)
const BACKGROUND_LEVELS = {
  low: 0.1,      // Very low natural background
  normal: 0.15,  // Average background
  elevated: 0.3, // Elevated but not dangerous
  high: 1.0,     // Significantly elevated
  dangerous: 10, // Immediate health risk
  lethal: 100    // Lethal exposure
};

// Locations of interest for radiation monitoring
const SENSITIVE_LOCATIONS = {
  // Nuclear power plants (some examples)
  chernobyl: { name: 'Chernobyl', lat: 51.389, lon: 30.099, type: 'disaster-site' },
  fukushima: { name: 'Fukushima', lat: 37.421, lon: 141.033, type: 'disaster-site' },
  zaporizhzhia: { name: 'Zaporizhzhia NPP', lat: 47.507, lon: 34.585, type: 'npp-warzone' },
  
  // Nuclear facilities mentioned in news
  fordow: { name: 'Fordow (Iran)', lat: 34.887, lon: 50.986, type: 'enrichment' },
  natanz: { name: 'Natanz (Iran)', lat: 33.724, lon: 51.727, type: 'enrichment' },
  dimona: { name: 'Dimona (Israel)', lat: 31.0, lon: 35.15, type: 'research' },
  
  // Major cities (for fallout detection)
  tehran: { name: 'Tehran', lat: 35.6892, lon: 51.389, type: 'city' },
  moscow: { name: 'Moscow', lat: 55.7558, lon: 37.6173, type: 'city' },
  washington: { name: 'Washington DC', lat: 38.9072, lon: -77.0369, type: 'city' },
  berlin: { name: 'Berlin', lat: 52.52, lon: 13.405, type: 'city' }
};

class RadiationMonitor {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes
    this.historicalData = [];
  }

  async monitorRadiation() {
    try {
      const [radmonData, gmcData] = await Promise.allSettled([
        this.fetchRadmon(),
        this.fetchGMCMap()
      ]);

      let allReadings = [];
      
      if (radmonData.status === 'fulfilled') {
        allReadings = [...allReadings, ...radmonData.value];
      }
      
      if (gmcData.status === 'fulfilled') {
        allReadings = [...allReadings, ...gmcData.value];
      }

      // Analyze readings
      const analyzedReadings = allReadings.map(r => this.analyzeReading(r));
      
      // Find anomalies
      const anomalies = analyzedReadings.filter(r => r.anomaly);
      
      // Update historical data
      this.updateHistory(analyzedReadings);

      return {
        timestamp: new Date(),
        count: analyzedReadings.length,
        readings: analyzedReadings.slice(0, 100),
        anomalies: anomalies,
        summary: this.generateSummary(analyzedReadings),
        globalStatus: this.assessGlobalStatus(analyzedReadings),
        sources: {
          radmon: radmonData.status === 'fulfilled' ? radmonData.value.length : 0,
          gmc: gmcData.status === 'fulfilled' ? gmcData.value.length : 0
        }
      };
    } catch (error) {
      console.error('[RADIATION] Error:', error.message);
      return {
        timestamp: new Date(),
        count: 0,
        readings: [],
        anomalies: [],
        summary: {},
        error: error.message
      };
    }
  }

  async fetchRadmon() {
    try {
      const cached = this.cache.get('radmon');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // Radmon.org API - FREE
      // Note: API may have rate limits
      const response = await axios.get('https://radmon.org/radmon.php', {
        params: {
          function: 'showlist',
          format: 'json'
        },
        timeout: 15000,
        headers: {
          'User-Agent': 'OSINT-Dashboard/1.0'
        }
      });

      // Parse response - format varies
      let readings = [];
      
      if (Array.isArray(response.data)) {
        readings = response.data.map(station => ({
          id: station.id || station.user,
          name: station.user || station.id,
          latitude: parseFloat(station.lat),
          longitude: parseFloat(station.lon),
          value: parseFloat(station.cpm) / 100, // Convert CPM to approximate µSv/h
          unit: 'µSv/h',
          cpm: parseFloat(station.cpm),
          lastUpdate: station.lastupdate ? new Date(station.lastupdate) : new Date(),
          source: 'radmon.org',
          country: station.country
        })).filter(r => !isNaN(r.latitude) && !isNaN(r.value));
      }

      this.cache.set('radmon', { data: readings, time: Date.now() });
      console.log(`[RADIATION] Radmon: ${readings.length} stations`);
      return readings;
    } catch (error) {
      console.error('[RADIATION] Radmon error:', error.message);
      return [];
    }
  }

  async fetchGMCMap() {
    try {
      const cached = this.cache.get('gmc');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // GMCMap.com - FREE Geiger counter network
      const response = await axios.get('https://www.gmcmap.com/gmc-data.php', {
        params: {
          action: 'getlist'
        },
        timeout: 15000,
        headers: {
          'User-Agent': 'OSINT-Dashboard/1.0'
        }
      });

      let readings = [];
      
      if (response.data && Array.isArray(response.data)) {
        readings = response.data.map(station => ({
          id: station.id,
          name: station.name || `GMC-${station.id}`,
          latitude: parseFloat(station.lat),
          longitude: parseFloat(station.lng || station.lon),
          value: parseFloat(station.usvh || station.cpm / 100),
          unit: 'µSv/h',
          cpm: parseFloat(station.cpm),
          lastUpdate: station.time ? new Date(station.time) : new Date(),
          source: 'gmcmap.com'
        })).filter(r => !isNaN(r.latitude) && !isNaN(r.value));
      }

      this.cache.set('gmc', { data: readings, time: Date.now() });
      console.log(`[RADIATION] GMCMap: ${readings.length} stations`);
      return readings;
    } catch (error) {
      console.error('[RADIATION] GMCMap error:', error.message);
      return [];
    }
  }

  analyzeReading(reading) {
    // Determine alert level
    let level = 'normal';
    let anomaly = false;
    let reasons = [];

    if (reading.value >= BACKGROUND_LEVELS.lethal) {
      level = 'LETHAL';
      anomaly = true;
      reasons.push('Lethal radiation level');
    } else if (reading.value >= BACKGROUND_LEVELS.dangerous) {
      level = 'DANGEROUS';
      anomaly = true;
      reasons.push('Dangerous radiation level');
    } else if (reading.value >= BACKGROUND_LEVELS.high) {
      level = 'HIGH';
      anomaly = true;
      reasons.push('Significantly elevated radiation');
    } else if (reading.value >= BACKGROUND_LEVELS.elevated) {
      level = 'ELEVATED';
      reasons.push('Elevated above normal background');
    }

    // Check proximity to sensitive locations
    let nearestSite = null;
    for (const [key, site] of Object.entries(SENSITIVE_LOCATIONS)) {
      const distance = this.calculateDistance(
        reading.latitude, reading.longitude,
        site.lat, site.lon
      );
      
      if (distance < 100) { // Within 100km
        nearestSite = { ...site, key, distance: Math.round(distance) };
        
        // Lower threshold for anomaly near sensitive sites
        if (reading.value >= BACKGROUND_LEVELS.elevated) {
          anomaly = true;
          reasons.push(`Near ${site.name}`);
        }
        break;
      }
    }

    return {
      ...reading,
      level,
      anomaly,
      reasons,
      nearestSite,
      percentAboveNormal: Math.round((reading.value / BACKGROUND_LEVELS.normal - 1) * 100)
    };
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  updateHistory(readings) {
    // Keep 24 hours of data
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.historicalData = this.historicalData.filter(h => h.timestamp > cutoff);
    
    // Add current average
    if (readings.length > 0) {
      const avg = readings.reduce((sum, r) => sum + r.value, 0) / readings.length;
      this.historicalData.push({
        timestamp: Date.now(),
        average: avg,
        max: Math.max(...readings.map(r => r.value)),
        count: readings.length
      });
    }
  }

  assessGlobalStatus(readings) {
    if (readings.length === 0) {
      return { status: 'UNKNOWN', message: 'No data available' };
    }

    const anomalies = readings.filter(r => r.anomaly);
    const dangerous = readings.filter(r => r.level === 'DANGEROUS' || r.level === 'LETHAL');
    
    if (dangerous.length > 0) {
      return {
        status: 'CRITICAL',
        message: `${dangerous.length} stations reporting dangerous levels`,
        color: '#FF0000'
      };
    }
    
    if (anomalies.length > 5) {
      return {
        status: 'ALERT',
        message: `${anomalies.length} stations showing elevated readings`,
        color: '#FF6600'
      };
    }
    
    if (anomalies.length > 0) {
      return {
        status: 'ELEVATED',
        message: `${anomalies.length} stations above normal`,
        color: '#FFCC00'
      };
    }
    
    return {
      status: 'NORMAL',
      message: 'All stations within normal range',
      color: '#00FF00'
    };
  }

  generateSummary(readings) {
    if (readings.length === 0) {
      return { total: 0 };
    }

    const values = readings.map(r => r.value);
    
    return {
      total: readings.length,
      average: (values.reduce((a, b) => a + b, 0) / values.length).toFixed(3),
      max: Math.max(...values).toFixed(3),
      min: Math.min(...values).toFixed(3),
      byLevel: {
        normal: readings.filter(r => r.level === 'normal').length,
        elevated: readings.filter(r => r.level === 'ELEVATED').length,
        high: readings.filter(r => r.level === 'HIGH').length,
        dangerous: readings.filter(r => r.level === 'DANGEROUS' || r.level === 'LETHAL').length
      },
      anomalies: readings.filter(r => r.anomaly).length,
      bySource: readings.reduce((acc, r) => {
        acc[r.source] = (acc[r.source] || 0) + 1;
        return acc;
      }, {})
    };
  }
}

module.exports = new RadiationMonitor();

