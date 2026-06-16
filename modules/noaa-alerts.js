const axios = require('axios');
const OsintModule = require('./base-module');

/**
 * NOAA Weather Alerts Module
 * 
 * Sources severe weather alerts from the National Weather Service API
 * API: https://api.weather.gov/alerts
 */

class NoaaAlertsModule extends OsintModule {
  constructor() {
    super();
    this.name = 'noaa-alerts';
    this.displayName = 'NOAA Weather Alerts';
    this.icon = '⛈️';
    this.category = 'geo';
    this.schedule = '*/5 * * * *';  // Every 5 minutes
    this.enabled = true;
    this.requiresEnv = [];
    
    this.cache = new Map();
    this.cacheTimeout = 180000; // 3 minutes
  }

  async update() {
    try {
      const [severeAlerts, allAlerts] = await Promise.allSettled([
        this.fetchSevereAlerts(),
        this.fetchActiveAlerts()
      ]);

      let alerts = [];
      
      if (severeAlerts.status === 'fulfilled') {
        alerts = [...alerts, ...severeAlerts.value];
      }
      
      if (allAlerts.status === 'fulfilled') {
        // Add non-severe but significant alerts
        const additionalAlerts = allAlerts.value
          .filter(alert => !alerts.find(a => a.id === alert.id))
          .filter(alert => ['Moderate', 'Major'].includes(alert.severity))
          .slice(0, 20);
        alerts = [...alerts, ...additionalAlerts];
      }

      // Sort by severity and time
      alerts.sort((a, b) => {
        const severityOrder = { 'Extreme': 4, 'Severe': 3, 'Moderate': 2, 'Minor': 1 };
        const aSeverity = severityOrder[a.severity] || 0;
        const bSeverity = severityOrder[b.severity] || 0;
        
        if (aSeverity !== bSeverity) {
          return bSeverity - aSeverity;
        }
        return new Date(b.sent) - new Date(a.sent);
      });

      return this.sanitizeData({
        timestamp: new Date(),
        count: alerts.length,
        alerts: alerts.slice(0, 100),
        summary: this.generateSummary(alerts),
        sources: {
          severe: severeAlerts.status === 'fulfilled' ? severeAlerts.value.length : 0,
          total: allAlerts.status === 'fulfilled' ? allAlerts.value.length : 0
        }
      });
    } catch (error) {
      console.error('[NOAA] Error:', error.message);
      return this.sanitizeData({
        timestamp: new Date(),
        count: 0,
        alerts: [],
        error: error.message
      });
    }
  }

  async fetchSevereAlerts() {
    try {
      const cached = this.cache.get('severe');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // NOAA Weather API - Free, no auth required
      const response = await axios.get('https://api.weather.gov/alerts', {
        params: {
          status: 'actual',
          severity: 'Extreme,Severe'
        },
        timeout: 15000,
        headers: {
          'User-Agent': 'OSINTExplorer/1.0 (contact@example.com)'
        }
      });

      if (!response.data || !response.data.features) {
        return [];
      }

      const alerts = response.data.features.map(feature => this.parseAlert(feature));

      this.cache.set('severe', { data: alerts, time: Date.now() });
      console.log(`[NOAA] Severe alerts: ${alerts.length}`);
      return alerts;
    } catch (error) {
      console.error('[NOAA] Severe alerts error:', error.message);
      return [];
    }
  }

  async fetchActiveAlerts() {
    try {
      const cached = this.cache.get('active');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      const response = await axios.get('https://api.weather.gov/alerts', {
        params: {
          status: 'actual',
          limit: 50
        },
        timeout: 15000,
        headers: {
          'User-Agent': 'OSINTExplorer/1.0 (contact@example.com)'
        }
      });

      if (!response.data || !response.data.features) {
        return [];
      }

      const alerts = response.data.features.map(feature => this.parseAlert(feature));

      this.cache.set('active', { data: alerts, time: Date.now() });
      console.log(`[NOAA] Active alerts: ${alerts.length}`);
      return alerts;
    } catch (error) {
      console.error('[NOAA] Active alerts error:', error.message);
      return [];
    }
  }

  parseAlert(feature) {
    const props = feature.properties;
    const geometry = feature.geometry;
    
    // Extract coordinates from geometry
    let coordinates = null;
    if (geometry && geometry.coordinates) {
      try {
        // Handle different geometry types
        if (geometry.type === 'Polygon' && geometry.coordinates[0]) {
          // Get center of polygon (rough approximation)
          const coords = geometry.coordinates[0];
          const lats = coords.map(c => c[1]);
          const lons = coords.map(c => c[0]);
          coordinates = {
            latitude: lats.reduce((a, b) => a + b) / lats.length,
            longitude: lons.reduce((a, b) => a + b) / lons.length
          };
        } else if (geometry.type === 'Point') {
          coordinates = {
            longitude: geometry.coordinates[0],
            latitude: geometry.coordinates[1]
          };
        }
      } catch (e) {
        // Ignore coordinate parsing errors
      }
    }

    return {
      id: props.id,
      title: props.headline || props.event,
      event: props.event,
      severity: props.severity,
      urgency: props.urgency,
      certainty: props.certainty,
      description: props.description,
      instruction: props.instruction,
      areaDesc: props.areaDesc,
      sent: new Date(props.sent),
      effective: props.effective ? new Date(props.effective) : null,
      expires: props.expires ? new Date(props.expires) : null,
      senderName: props.senderName,
      coordinates: coordinates,
      url: `https://api.weather.gov/alerts/${props.id}`,
      category: this.categorizeAlert(props.event),
      riskLevel: this.calculateRiskLevel(props.severity, props.urgency, props.certainty)
    };
  }

  categorizeAlert(event) {
    if (!event) return 'other';
    
    const eventLower = event.toLowerCase();
    
    if (eventLower.includes('tornado')) return 'tornado';
    if (eventLower.includes('hurricane') || eventLower.includes('tropical storm')) return 'hurricane';
    if (eventLower.includes('flood') || eventLower.includes('flash flood')) return 'flood';
    if (eventLower.includes('thunderstorm') || eventLower.includes('severe weather')) return 'storm';
    if (eventLower.includes('blizzard') || eventLower.includes('winter storm')) return 'winter';
    if (eventLower.includes('heat') || eventLower.includes('excessive heat')) return 'heat';
    if (eventLower.includes('fire') || eventLower.includes('red flag')) return 'fire';
    if (eventLower.includes('tsunami')) return 'tsunami';
    
    return 'other';
  }

  calculateRiskLevel(severity, urgency, certainty) {
    const severityScore = { 'Extreme': 4, 'Severe': 3, 'Moderate': 2, 'Minor': 1 };
    const urgencyScore = { 'Immediate': 4, 'Expected': 3, 'Future': 2, 'Past': 1 };
    const certaintyScore = { 'Observed': 4, 'Likely': 3, 'Possible': 2, 'Unlikely': 1 };
    
    const total = (severityScore[severity] || 0) + 
                  (urgencyScore[urgency] || 0) + 
                  (certaintyScore[certainty] || 0);
    
    if (total >= 10) return 'CRITICAL';
    if (total >= 7) return 'HIGH';
    if (total >= 4) return 'MODERATE';
    return 'LOW';
  }

  generateSummary(alerts) {
    const bySeverity = {};
    const byCategory = {};
    const byState = {};
    let criticalCount = 0;

    alerts.forEach(alert => {
      // By severity
      bySeverity[alert.severity] = (bySeverity[alert.severity] || 0) + 1;
      
      // By category
      byCategory[alert.category] = (byCategory[alert.category] || 0) + 1;
      
      // By state (extract from areaDesc)
      if (alert.areaDesc) {
        const stateMatch = alert.areaDesc.match(/\b([A-Z]{2})\b/);
        if (stateMatch) {
          byState[stateMatch[1]] = (byState[stateMatch[1]] || 0) + 1;
        }
      }
      
      // Count critical alerts
      if (alert.riskLevel === 'CRITICAL') {
        criticalCount++;
      }
    });

    return {
      total: alerts.length,
      critical: criticalCount,
      bySeverity,
      byCategory,
      topStates: Object.entries(byState)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([state, count]) => ({ state, count })),
      mostCommonEvent: Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0]
    };
  }

  getDefaultState() {
    return {
      timestamp: null,
      count: 0,
      alerts: [],
      summary: {
        total: 0,
        critical: 0,
        bySeverity: {},
        byCategory: {},
        topStates: [],
        mostCommonEvent: null
      }
    };
  }

  getAlerts(data) {
    const alerts = [];
    
    // Alert on extreme weather events
    if (data.alerts) {
      const extremeAlerts = data.alerts.filter(a => a.severity === 'Extreme').length;
      if (extremeAlerts > 0) {
        alerts.push({
          id: `noaa_extreme_${Date.now()}`,
          type: 'WEATHER',
          severity: 'CRITICAL',
          message: `${extremeAlerts} extreme weather alert(s) active`,
          timestamp: new Date(),
          data: { extremeAlerts }
        });
      }

      // Alert on widespread severe weather
      const severeAlerts = data.alerts.filter(a => a.severity === 'Severe').length;
      if (severeAlerts > 10) {
        alerts.push({
          id: `noaa_widespread_${Date.now()}`,
          type: 'WEATHER',
          severity: 'HIGH',
          message: `Widespread severe weather: ${severeAlerts} alerts active`,
          timestamp: new Date(),
          data: { severeAlerts }
        });
      }
    }
    
    return alerts;
  }
}

module.exports = new NoaaAlertsModule();
