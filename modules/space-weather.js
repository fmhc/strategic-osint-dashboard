const axios = require('axios');

/**
 * Space Weather Monitor Module
 * 
 * Monitors solar activity, geomagnetic storms, and ionospheric disturbances
 * Useful for: GPS disruption prediction, communications blackouts, EMP indicators
 * 
 * FREE Data Sources:
 * - NOAA Space Weather Prediction Center (SWPC)
 * - NASA DONKI (Database of Notifications, Knowledge, Information)
 * - DSCOVR satellite data
 */

// Geomagnetic storm levels (NOAA G-scale)
const STORM_LEVELS = {
  G0: { name: 'Quiet', severity: 'NORMAL', impact: 'No impact' },
  G1: { name: 'Minor', severity: 'LOW', impact: 'Weak power grid fluctuations, minor satellite operations impact' },
  G2: { name: 'Moderate', severity: 'MEDIUM', impact: 'High-latitude power systems affected, spacecraft orientation corrections' },
  G3: { name: 'Strong', severity: 'HIGH', impact: 'Voltage corrections required, surface charging on satellites' },
  G4: { name: 'Severe', severity: 'CRITICAL', impact: 'Widespread voltage problems, spacecraft may experience surface charging' },
  G5: { name: 'Extreme', severity: 'CRITICAL', impact: 'Widespread blackouts, satellite damage, HF radio blackout' }
};

// Solar flare classification
const FLARE_CLASSES = {
  A: { severity: 'MINIMAL', impact: 'Background level' },
  B: { severity: 'LOW', impact: 'Minor solar activity' },
  C: { severity: 'MEDIUM', impact: 'Minor radio blackouts' },
  M: { severity: 'HIGH', impact: 'Brief radio blackouts, minor radiation storms' },
  X: { severity: 'CRITICAL', impact: 'Major radio blackouts, radiation storms, possible CME' }
};

class SpaceWeatherMonitor {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes
  }

  async monitorSpaceWeather() {
    try {
      const [currentConditions, solarFlares, geomagStorms, cme] = await Promise.allSettled([
        this.fetchCurrentConditions(),
        this.fetchSolarFlares(),
        this.fetchGeomagneticStorms(),
        this.fetchCME()
      ]);

      const data = {
        timestamp: new Date(),
        current: currentConditions.status === 'fulfilled' ? currentConditions.value : null,
        solarFlares: solarFlares.status === 'fulfilled' ? solarFlares.value : [],
        geomagneticStorms: geomagStorms.status === 'fulfilled' ? geomagStorms.value : [],
        cme: cme.status === 'fulfilled' ? cme.value : [],
        summary: {},
        alerts: []
      };

      // Generate summary and alerts
      data.summary = this.generateSummary(data);
      data.alerts = this.generateAlerts(data);

      return data;
    } catch (error) {
      console.error('[SPACE] Error:', error.message);
      return {
        timestamp: new Date(),
        current: null,
        solarFlares: [],
        geomagneticStorms: [],
        cme: [],
        summary: {},
        alerts: [],
        error: error.message
      };
    }
  }

  async fetchCurrentConditions() {
    try {
      const cached = this.cache.get('current');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // NOAA SWPC - Current conditions
      const response = await axios.get('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', {
        timeout: 10000
      });

      if (!response.data || response.data.length < 2) {
        return null;
      }

      // Get latest reading (skip header row)
      const latest = response.data[response.data.length - 1];
      
      const kpIndex = parseFloat(latest[1]);
      const gLevel = this.kpToGLevel(kpIndex);
      
      const data = {
        timestamp: new Date(latest[0]),
        kpIndex: kpIndex,
        gLevel: gLevel,
        stormInfo: STORM_LEVELS[gLevel],
        a_running: parseFloat(latest[2]) || null
      };

      this.cache.set('current', { data, time: Date.now() });
      console.log(`[SPACE] Current Kp: ${kpIndex} (${gLevel})`);
      return data;
    } catch (error) {
      console.error('[SPACE] Current conditions error:', error.message);
      return null;
    }
  }

  async fetchSolarFlares() {
    try {
      const cached = this.cache.get('flares');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // NASA DONKI - Solar Flare API (FREE)
      const endDate = new Date().toISOString().split('T')[0];
      const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      const response = await axios.get('https://api.nasa.gov/DONKI/FLR', {
        params: {
          startDate,
          endDate,
          api_key: 'DEMO_KEY' // Free demo key, or get your own at api.nasa.gov
        },
        timeout: 15000
      });

      if (!Array.isArray(response.data)) {
        return [];
      }

      const flares = response.data.map(flare => {
        const flareClass = flare.classType ? flare.classType.charAt(0).toUpperCase() : 'Unknown';
        
        return {
          id: flare.flrID,
          beginTime: new Date(flare.beginTime),
          peakTime: flare.peakTime ? new Date(flare.peakTime) : null,
          endTime: flare.endTime ? new Date(flare.endTime) : null,
          classType: flare.classType,
          classCategory: flareClass,
          severity: FLARE_CLASSES[flareClass]?.severity || 'UNKNOWN',
          sourceLocation: flare.sourceLocation,
          linkedEvents: flare.linkedEvents || []
        };
      });

      this.cache.set('flares', { data: flares, time: Date.now() });
      console.log(`[SPACE] Solar flares: ${flares.length} in last 7 days`);
      return flares;
    } catch (error) {
      console.error('[SPACE] Solar flares error:', error.message);
      return [];
    }
  }

  async fetchGeomagneticStorms() {
    try {
      const cached = this.cache.get('geomag');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // NASA DONKI - Geomagnetic Storm API
      const endDate = new Date().toISOString().split('T')[0];
      const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      const response = await axios.get('https://api.nasa.gov/DONKI/GST', {
        params: {
          startDate,
          endDate,
          api_key: 'DEMO_KEY'
        },
        timeout: 15000
      });

      if (!Array.isArray(response.data)) {
        return [];
      }

      const storms = response.data.map(storm => ({
        id: storm.gstID,
        startTime: new Date(storm.startTime),
        allKpIndex: storm.allKpIndex || [],
        linkedEvents: storm.linkedEvents || [],
        maxKp: storm.allKpIndex ? Math.max(...storm.allKpIndex.map(k => k.kpIndex || 0)) : null
      }));

      this.cache.set('geomag', { data: storms, time: Date.now() });
      console.log(`[SPACE] Geomagnetic storms: ${storms.length} in last 7 days`);
      return storms;
    } catch (error) {
      console.error('[SPACE] Geomagnetic storms error:', error.message);
      return [];
    }
  }

  async fetchCME() {
    try {
      const cached = this.cache.get('cme');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // NASA DONKI - Coronal Mass Ejection API
      const endDate = new Date().toISOString().split('T')[0];
      const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      const response = await axios.get('https://api.nasa.gov/DONKI/CME', {
        params: {
          startDate,
          endDate,
          api_key: 'DEMO_KEY'
        },
        timeout: 15000
      });

      if (!Array.isArray(response.data)) {
        return [];
      }

      const cmes = response.data.map(cme => ({
        id: cme.activityID,
        startTime: new Date(cme.startTime),
        sourceLocation: cme.sourceLocation,
        note: cme.note,
        instruments: cme.instruments?.map(i => i.displayName) || [],
        cmeAnalyses: cme.cmeAnalyses?.map(a => ({
          speed: a.speed,
          type: a.type,
          latitude: a.latitude,
          longitude: a.longitude,
          halfAngle: a.halfAngle,
          earthGlancingBlow: a.isEarthGlancingBlow
        })) || [],
        linkedEvents: cme.linkedEvents || []
      }));

      this.cache.set('cme', { data: cmes, time: Date.now() });
      console.log(`[SPACE] CMEs: ${cmes.length} in last 7 days`);
      return cmes;
    } catch (error) {
      console.error('[SPACE] CME error:', error.message);
      return [];
    }
  }

  kpToGLevel(kp) {
    if (kp >= 9) return 'G5';
    if (kp >= 8) return 'G4';
    if (kp >= 7) return 'G3';
    if (kp >= 6) return 'G2';
    if (kp >= 5) return 'G1';
    return 'G0';
  }

  generateSummary(data) {
    const summary = {
      currentStatus: data.current ? {
        kpIndex: data.current.kpIndex,
        gLevel: data.current.gLevel,
        severity: data.current.stormInfo?.severity
      } : 'Unknown',
      solarActivity: {
        total: data.solarFlares.length,
        xClass: data.solarFlares.filter(f => f.classCategory === 'X').length,
        mClass: data.solarFlares.filter(f => f.classCategory === 'M').length
      },
      geomagneticActivity: {
        storms: data.geomagneticStorms.length,
        maxKp: data.geomagneticStorms.length > 0 ? 
          Math.max(...data.geomagneticStorms.map(s => s.maxKp || 0)) : 0
      },
      cmeActivity: {
        total: data.cme.length,
        earthDirected: data.cme.filter(c => 
          c.cmeAnalyses?.some(a => a.earthGlancingBlow)
        ).length
      }
    };

    // Overall assessment
    let overallSeverity = 'NORMAL';
    
    if (data.current?.stormInfo?.severity === 'CRITICAL' ||
        data.solarFlares.some(f => f.classCategory === 'X')) {
      overallSeverity = 'CRITICAL';
    } else if (data.current?.stormInfo?.severity === 'HIGH' ||
               data.solarFlares.some(f => f.classCategory === 'M')) {
      overallSeverity = 'HIGH';
    } else if (data.current?.kpIndex >= 4) {
      overallSeverity = 'ELEVATED';
    }
    
    summary.overallSeverity = overallSeverity;
    
    return summary;
  }

  generateAlerts(data) {
    const alerts = [];

    // Current geomagnetic storm
    if (data.current?.kpIndex >= 5) {
      alerts.push({
        type: 'GEOMAGNETIC_STORM',
        severity: data.current.stormInfo.severity,
        message: `Active ${data.current.gLevel} geomagnetic storm (Kp=${data.current.kpIndex})`,
        impact: data.current.stormInfo.impact,
        timestamp: data.current.timestamp
      });
    }

    // Recent X-class flares
    const recentXFlares = data.solarFlares.filter(f => 
      f.classCategory === 'X' && 
      (Date.now() - f.beginTime.getTime()) < 24 * 60 * 60 * 1000
    );
    
    for (const flare of recentXFlares) {
      alerts.push({
        type: 'X_CLASS_FLARE',
        severity: 'CRITICAL',
        message: `X-class solar flare: ${flare.classType}`,
        impact: 'Major HF radio blackouts, radiation storms possible',
        timestamp: flare.beginTime
      });
    }

    // Earth-directed CMEs
    const earthCMEs = data.cme.filter(c => 
      c.cmeAnalyses?.some(a => a.earthGlancingBlow) &&
      (Date.now() - c.startTime.getTime()) < 48 * 60 * 60 * 1000
    );
    
    for (const cme of earthCMEs) {
      alerts.push({
        type: 'EARTH_DIRECTED_CME',
        severity: 'HIGH',
        message: 'Earth-directed Coronal Mass Ejection detected',
        impact: 'Geomagnetic storm possible in 1-3 days',
        timestamp: cme.startTime
      });
    }

    return alerts;
  }
}

module.exports = new SpaceWeatherMonitor();

