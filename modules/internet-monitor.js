const axios = require('axios');

/**
 * Internet/Network Monitor Module
 * 
 * Monitors global internet connectivity and outages
 * Useful for: Cyber attacks, government shutdowns, infrastructure damage
 * 
 * FREE Data Sources:
 * - Cloudflare Radar (network data)
 * - IODA (Internet Outage Detection and Analysis)
 * - BGPStream (routing anomalies)
 * - ThousandEyes (limited public data)
 */

// Countries of interest for monitoring
const MONITORED_COUNTRIES = {
  IR: { name: 'Iran', priority: 'CRITICAL', notes: 'Frequent government shutdowns during protests' },
  VE: { name: 'Venezuela', priority: 'HIGH', notes: 'Post-invasion infrastructure' },
  RU: { name: 'Russia', priority: 'HIGH', notes: 'Sanctions and isolation' },
  CN: { name: 'China', priority: 'MEDIUM', notes: 'Great Firewall' },
  UA: { name: 'Ukraine', priority: 'HIGH', notes: 'Active conflict zone' },
  SY: { name: 'Syria', priority: 'MEDIUM', notes: 'Conflict zone' },
  KP: { name: 'North Korea', priority: 'HIGH', notes: 'Limited connectivity' },
  CU: { name: 'Cuba', priority: 'MEDIUM', notes: 'US sanctions' },
  BY: { name: 'Belarus', priority: 'MEDIUM', notes: 'Government control' },
  MM: { name: 'Myanmar', priority: 'MEDIUM', notes: 'Military junta control' }
};

// Known submarine cable landing points and internet exchange points
const CRITICAL_INFRASTRUCTURE = {
  cables: [
    { name: 'FLAG Europe-Asia', regions: ['Middle East', 'Asia', 'Europe'] },
    { name: 'SEA-ME-WE 3', regions: ['Southeast Asia', 'Middle East', 'Europe'] },
    { name: 'TAT-14', regions: ['North Atlantic'] },
    { name: 'MAREA', regions: ['Spain', 'USA'] }
  ]
};

class InternetMonitor {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes
    this.historicalData = [];
  }

  async monitorInternet() {
    try {
      const [cloudflareData, iodaData] = await Promise.allSettled([
        this.fetchCloudflareRadar(),
        this.fetchIODA()
      ]);

      let outages = [];
      let attackData = [];
      
      if (cloudflareData.status === 'fulfilled') {
        outages = [...outages, ...(cloudflareData.value.outages || [])];
        attackData = cloudflareData.value.attacks || [];
      }
      
      if (iodaData.status === 'fulfilled') {
        outages = [...outages, ...iodaData.value];
      }

      // Analyze and deduplicate
      const analyzedOutages = this.analyzeOutages(outages);
      
      return {
        timestamp: new Date(),
        outages: analyzedOutages,
        attacks: attackData,
        summary: this.generateSummary(analyzedOutages, attackData),
        monitoredCountries: this.getCountryStatus(analyzedOutages),
        sources: {
          cloudflare: cloudflareData.status === 'fulfilled',
          ioda: iodaData.status === 'fulfilled'
        }
      };
    } catch (error) {
      console.error('[INTERNET] Error:', error.message);
      return {
        timestamp: new Date(),
        outages: [],
        attacks: [],
        summary: {},
        error: error.message
      };
    }
  }

  async fetchCloudflareRadar() {
    try {
      const cached = this.cache.get('cloudflare');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // Cloudflare Radar API - Some endpoints are public
      // Note: Full API requires authentication
      const outages = [];
      const attacks = [];

      // Try to get outage data from public endpoint
      try {
        const response = await axios.get('https://radar.cloudflare.com/api/v1/annotations/outages', {
          params: {
            limit: 50,
            dateRange: '7d'
          },
          timeout: 10000,
          headers: {
            'User-Agent': 'OSINT-Dashboard/1.0'
          }
        });

        if (response.data?.annotations) {
          for (const annotation of response.data.annotations) {
            outages.push({
              id: annotation.id,
              country: annotation.asn ? null : annotation.location,
              asn: annotation.asn,
              startTime: new Date(annotation.startDate),
              endTime: annotation.endDate ? new Date(annotation.endDate) : null,
              ongoing: !annotation.endDate,
              type: annotation.type || 'outage',
              description: annotation.description,
              source: 'cloudflare'
            });
          }
        }
      } catch (e) {
        // API may not be publicly accessible
        console.log('[INTERNET] Cloudflare annotations not available:', e.message);
      }

      // Try attack data
      try {
        const attackResponse = await axios.get('https://radar.cloudflare.com/api/v1/attacks/layer3/summary', {
          params: {
            dateRange: '7d'
          },
          timeout: 10000
        });

        if (attackResponse.data?.summary) {
          attacks.push({
            type: 'Layer 3/4 DDoS',
            count: attackResponse.data.summary.totalAttacks,
            source: 'cloudflare'
          });
        }
      } catch (e) {
        console.log('[INTERNET] Cloudflare attack data not available');
      }

      const data = { outages, attacks };
      this.cache.set('cloudflare', { data, time: Date.now() });
      return data;
    } catch (error) {
      console.error('[INTERNET] Cloudflare error:', error.message);
      return { outages: [], attacks: [] };
    }
  }

  async fetchIODA() {
    try {
      const cached = this.cache.get('ioda');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // IODA (Internet Outage Detection and Analysis) - FREE
      // Georgia Tech / CAIDA
      const endTime = Math.floor(Date.now() / 1000);
      const startTime = endTime - 24 * 60 * 60; // Last 24 hours

      const outages = [];

      // Check monitored countries
      for (const [code, info] of Object.entries(MONITORED_COUNTRIES)) {
        try {
          const response = await axios.get(`https://api.ioda.inetintel.cc.gatech.edu/v2/signals/country/${code}`, {
            params: {
              from: startTime,
              until: endTime
            },
            timeout: 10000
          });

          if (response.data?.data) {
            // Analyze signal data for outages
            const signals = response.data.data;
            
            // Look for significant drops
            for (const signal of signals) {
              if (signal.value < 0.7) { // 30% drop threshold
                outages.push({
                  id: `ioda-${code}-${signal.time}`,
                  country: code,
                  countryName: info.name,
                  time: new Date(signal.time * 1000),
                  severity: signal.value < 0.3 ? 'CRITICAL' : signal.value < 0.5 ? 'HIGH' : 'MEDIUM',
                  dropPercent: Math.round((1 - signal.value) * 100),
                  source: 'IODA',
                  priority: info.priority,
                  notes: info.notes
                });
              }
            }
          }
        } catch (e) {
          // Continue with other countries
        }
      }

      this.cache.set('ioda', { data: outages, time: Date.now() });
      console.log(`[INTERNET] IODA: ${outages.length} potential outages detected`);
      return outages;
    } catch (error) {
      console.error('[INTERNET] IODA error:', error.message);
      return [];
    }
  }

  analyzeOutages(outages) {
    return outages.map(outage => {
      // Determine severity if not set
      let severity = outage.severity || 'MEDIUM';
      let significance = 'NORMAL';
      
      // Check if it's a monitored high-priority country
      const countryInfo = MONITORED_COUNTRIES[outage.country];
      if (countryInfo) {
        if (countryInfo.priority === 'CRITICAL') {
          significance = 'CRITICAL';
        } else if (countryInfo.priority === 'HIGH') {
          significance = 'HIGH';
        }
      }
      
      // Ongoing outages are more significant
      if (outage.ongoing) {
        significance = significance === 'NORMAL' ? 'ELEVATED' : significance;
      }
      
      return {
        ...outage,
        severity,
        significance,
        countryInfo: countryInfo || null
      };
    });
  }

  getCountryStatus(outages) {
    const status = {};
    
    for (const [code, info] of Object.entries(MONITORED_COUNTRIES)) {
      const countryOutages = outages.filter(o => o.country === code);
      const hasOngoing = countryOutages.some(o => o.ongoing);
      const hasCritical = countryOutages.some(o => o.severity === 'CRITICAL');
      
      status[code] = {
        name: info.name,
        priority: info.priority,
        status: hasCritical ? 'CRITICAL' : hasOngoing ? 'OUTAGE' : 'NORMAL',
        outageCount: countryOutages.length,
        notes: info.notes
      };
    }
    
    return status;
  }

  generateSummary(outages, attacks) {
    return {
      totalOutages: outages.length,
      ongoingOutages: outages.filter(o => o.ongoing).length,
      bySeverity: {
        critical: outages.filter(o => o.severity === 'CRITICAL').length,
        high: outages.filter(o => o.severity === 'HIGH').length,
        medium: outages.filter(o => o.severity === 'MEDIUM').length
      },
      attacksDetected: attacks.length > 0,
      monitoredCountriesAffected: Object.keys(
        outages.reduce((acc, o) => {
          if (MONITORED_COUNTRIES[o.country]) acc[o.country] = true;
          return acc;
        }, {})
      ).length
    };
  }
}

module.exports = new InternetMonitor();

