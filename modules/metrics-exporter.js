const client = require('prom-client');

/**
 * Prometheus Metrics Exporter
 * Exposes OSINT data as Prometheus metrics for Grafana
 */

class MetricsExporter {
  constructor() {
    // Create a Registry
    this.register = new client.Registry();
    
    // Add default metrics (CPU, memory, etc.)
    client.collectDefaultMetrics({ register: this.register });
    
    // Custom Gauges for OSINT data
    this.pizzaIndexGauge = new client.Gauge({
      name: 'osint_pizza_index',
      help: 'Pentagon Pizza Index - indicator of military activity',
      registers: [this.register]
    });
    
    this.flightsCountGauge = new client.Gauge({
      name: 'osint_flights_count',
      help: 'Number of tracked strategic flights',
      labelNames: ['category', 'threat_level'],
      registers: [this.register]
    });
    
    this.shipsCountGauge = new client.Gauge({
      name: 'osint_ships_count',
      help: 'Number of tracked vessels',
      labelNames: ['type', 'alert_status'],
      registers: [this.register]
    });
    
    this.gpsJammingGauge = new client.Gauge({
      name: 'osint_gps_jamming_zones',
      help: 'Number of active GPS jamming zones',
      registers: [this.register]
    });
    
    this.eamCountGauge = new client.Gauge({
      name: 'osint_eam_count',
      help: 'Number of Emergency Action Messages (Skyking)',
      registers: [this.register]
    });
    
    this.threatLevelGauge = new client.Gauge({
      name: 'osint_threat_level',
      help: 'Overall threat level (0=NORMAL, 1=MEDIUM, 2=ELEVATED, 3=HIGH, 4=CRITICAL)',
      registers: [this.register]
    });
    
    this.newsRelevanceGauge = new client.Gauge({
      name: 'osint_news_relevance_avg',
      help: 'Average relevance score of news articles',
      registers: [this.register]
    });
    
    this.cyberIncidentsGauge = new client.Gauge({
      name: 'osint_cyber_incidents',
      help: 'Number of detected cyber incidents',
      labelNames: ['severity'],
      registers: [this.register]
    });

    // Satellite imagery metrics
    this.satelliteLayersGauge = new client.Gauge({
      name: 'osint_satellite_layers_available',
      help: 'Number of available satellite imagery layers',
      registers: [this.register]
    });

    this.satelliteLastUpdateGauge = new client.Gauge({
      name: 'osint_satellite_last_update',
      help: 'Timestamp of last satellite imagery update (unix epoch)',
      registers: [this.register]
    });

    this.satelliteZoneCoverageGauge = new client.Gauge({
      name: 'osint_satellite_zone_coverage',
      help: 'Number of strategic zones with imagery coverage',
      labelNames: ['priority'],
      registers: [this.register]
    });

    this.satelliteWaybackVersionsGauge = new client.Gauge({
      name: 'osint_satellite_wayback_versions',
      help: 'Number of available ESRI Wayback historical versions',
      registers: [this.register]
    });

    this.gdacsEventsGauge = new client.Gauge({
      name: 'osint_gdacs_events',
      help: 'GDACS disaster events by alert level',
      labelNames: ['alert_level'],
      registers: [this.register]
    });

    this.eonetEventsGauge = new client.Gauge({
      name: 'osint_eonet_events',
      help: 'NASA EONET open natural events by category',
      labelNames: ['category'],
      registers: [this.register]
    });
  }
  
  updateMetrics(globalState) {
    try {
      // Pizza Index
      if (globalState.pizzaIndex) {
        this.pizzaIndexGauge.set(globalState.pizzaIndex.value || 0);
      }
      
      // Flights
      if (globalState.flights) {
        const flightData = Array.isArray(globalState.flights) ? globalState.flights : globalState.flights.flights || [];
        
        // Reset previous values
        this.flightsCountGauge.reset();
        
        // Count by category and threat level
        const categoryCounts = {};
        flightData.forEach(flight => {
          const category = flight.category || 'unknown';
          const threatLevel = flight.threatLevel || 'LOW';
          const key = `${category}_${threatLevel}`;
          categoryCounts[key] = (categoryCounts[key] || 0) + 1;
        });
        
        Object.entries(categoryCounts).forEach(([key, count]) => {
          const [category, threatLevel] = key.split('_');
          this.flightsCountGauge.set({ category, threat_level: threatLevel }, count);
        });
      }
      
      // Ships
      if (globalState.ships) {
        const shipsData = Array.isArray(globalState.ships) ? globalState.ships : globalState.ships.vessels || [];
        
        this.shipsCountGauge.reset();
        
        const shipCounts = {};
        shipsData.forEach(ship => {
          const type = ship.type || 'unknown';
          const alertStatus = ship.alertStatus || 'LOW';
          const key = `${type}_${alertStatus}`;
          shipCounts[key] = (shipCounts[key] || 0) + 1;
        });
        
        Object.entries(shipCounts).forEach(([key, count]) => {
          const [type, alertStatus] = key.split('_');
          this.shipsCountGauge.set({ type, alert_status: alertStatus }, count);
        });
      }
      
      // Signals
      if (globalState.signals) {
        const gpsJamming = globalState.signals.gpsJamming || [];
        this.gpsJammingGauge.set(gpsJamming.length);
        
        const eams = globalState.signals.eams || [];
        this.eamCountGauge.set(eams.length);
      }
      
      // Threat Level
      const threatLevelMap = {
        'NORMAL': 0,
        'MEDIUM': 1,
        'ELEVATED': 2,
        'HIGH': 3,
        'CRITICAL': 4
      };
      
      if (globalState.signals && globalState.signals.summary && globalState.signals.summary.threatLevel) {
        const threatValue = threatLevelMap[globalState.signals.summary.threatLevel] || 0;
        this.threatLevelGauge.set(threatValue);
      }
      
      // News
      if (globalState.news) {
        const newsData = Array.isArray(globalState.news) ? globalState.news : globalState.news.articles || [];
        if (newsData.length > 0) {
          const avgRelevance = newsData.reduce((sum, article) => sum + (article.relevance || 0), 0) / newsData.length;
          this.newsRelevanceGauge.set(avgRelevance);
        }
      }
      
      // Cyber Incidents
      if (globalState.cyberIncidents) {
        const incidents = Array.isArray(globalState.cyberIncidents) ? globalState.cyberIncidents : globalState.cyberIncidents.incidents || [];

        this.cyberIncidentsGauge.reset();

        const incidentCounts = {};
        incidents.forEach(incident => {
          const severity = incident.severity || 'UNKNOWN';
          incidentCounts[severity] = (incidentCounts[severity] || 0) + 1;
        });

        Object.entries(incidentCounts).forEach(([severity, count]) => {
          this.cyberIncidentsGauge.set({ severity }, count);
        });
      }

      // Satellite Imagery
      if (globalState.satellite) {
        const sat = globalState.satellite;

        // Number of sources
        this.satelliteLayersGauge.set(sat.sources || 4);

        // Last update timestamp
        if (sat.timestamp) {
          this.satelliteLastUpdateGauge.set(new Date(sat.timestamp).getTime() / 1000);
        }

        // Wayback versions
        if (sat.wayback && sat.wayback.versionsAvailable) {
          this.satelliteWaybackVersionsGauge.set(sat.wayback.versionsAvailable);
        }

        // Zone coverage by priority
        if (sat.zones) {
          this.satelliteZoneCoverageGauge.reset();
          this.satelliteZoneCoverageGauge.set({ priority: 'CRITICAL' }, sat.zones.criticalZones || 0);
          this.satelliteZoneCoverageGauge.set({ priority: 'ALL' }, sat.zones.totalZones || 0);
        }
      }

      // GDACS disaster events by alert level
      const gdacs = globalState['gdacs-monitor'];
      if (gdacs && gdacs.summary && gdacs.summary.byAlert) {
        this.gdacsEventsGauge.reset();
        for (const [level, count] of Object.entries(gdacs.summary.byAlert)) {
          this.gdacsEventsGauge.set({ alert_level: level }, count);
        }
      }

      // NASA EONET open natural events by category
      const eonet = globalState['eonet-monitor'];
      if (eonet && eonet.summary && eonet.summary.byCategory) {
        this.eonetEventsGauge.reset();
        for (const [category, count] of Object.entries(eonet.summary.byCategory)) {
          this.eonetEventsGauge.set({ category }, count);
        }
      }

    } catch (error) {
      console.error('[METRICS] Error updating metrics:', error.message);
    }
  }
  
  getMetrics() {
    return this.register.metrics();
  }
}

module.exports = new MetricsExporter();

