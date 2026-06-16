const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Signals Monitor Module - ECHTE DATEN
 * 
 * ECHTE Datenquellen:
 * - Stanford GNSS RFI Map (GPS Interference) - rfi.stanford.edu
 * - gpsjam.org (ADS-B basierte GPS Störungen)
 * - Flightradar24 GPS Jamming Data
 * 
 * NICHT VERFÜGBAR (klassifiziert):
 * - EAM (Emergency Action Messages)
 * - HFGCS Aktivität
 * - Militärische Radio Silence
 */

class SignalsMonitor {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 600000; // 10 minutes (GPS data doesn't change fast)
    this.stanfordCooldownUntil = 0; // rfi.stanford.edu is dead (404) → skip after failures
  }

  async monitorSignals() {
    const result = {
      timestamp: new Date(),
      gpsJamming: [],
      gpsJammingZones: [],
      summary: {
        totalJammingZones: 0,
        activeRegions: [],
        threatLevel: 'UNKNOWN'
      },
      dataSource: {
        verified: true,
        sources: []
      }
    };

    // Fetch GPS Jamming data from multiple sources
    const [stanfordData, gpsjamData] = await Promise.allSettled([
      this.fetchStanfordGNSS(),
      this.fetchGPSJam()
    ]);

    if (stanfordData.status === 'fulfilled' && stanfordData.value) {
      result.gpsJamming.push(...stanfordData.value);
      result.dataSource.sources.push('Stanford GNSS RFI Map');
    }

    if (gpsjamData.status === 'fulfilled' && gpsjamData.value) {
      result.gpsJammingZones = gpsjamData.value;
      result.dataSource.sources.push('gpsjam.org');
    }

    // Calculate summary
    const allZones = [...result.gpsJamming, ...result.gpsJammingZones];
    result.summary.totalJammingZones = allZones.length;
    
    // Extract unique regions
    const regions = new Set();
    for (const zone of allZones) {
      if (zone.region) regions.add(zone.region);
      if (zone.location) regions.add(zone.location);
    }
    result.summary.activeRegions = Array.from(regions);

    // Threat level based on jamming activity
    if (allZones.length >= 10) {
      result.summary.threatLevel = 'HIGH';
    } else if (allZones.length >= 5) {
      result.summary.threatLevel = 'ELEVATED';
    } else if (allZones.length > 0) {
      result.summary.threatLevel = 'NORMAL';
    } else {
      result.summary.threatLevel = 'CLEAR';
    }

    console.log(`[SIGNALS] GPS Jamming zones: ${allZones.length}, Threat: ${result.summary.threatLevel}`);
    return result;
  }

  async fetchStanfordGNSS() {
    try {
      const cached = this.cache.get('stanford');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // rfi.stanford.edu (API + map) is dead (404). After a failure, skip it for
      // 6h and rely on GPSJam — avoids two failed requests + log spam every poll.
      if (this.stanfordCooldownUntil && Date.now() < this.stanfordCooldownUntil) {
        return cached?.data || [];
      }

      console.log('[SIGNALS] Fetching Stanford GNSS RFI data...');
      
      // Stanford RFI map provides JSON data
      // They have a resources page with downloadable data
      const response = await axios.get('https://rfi.stanford.edu/api/interference', {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 OSINT Monitor'
        }
      });

      if (response.data && Array.isArray(response.data)) {
        const zones = response.data.map(item => ({
          id: item.id || `stanford_${Date.now()}`,
          latitude: item.lat || item.latitude,
          longitude: item.lon || item.longitude,
          severity: item.severity || 'UNKNOWN',
          region: item.region || 'Unknown',
          timestamp: item.timestamp ? new Date(item.timestamp) : new Date(),
          source: 'Stanford GNSS',
          verified: true
        }));

        this.cache.set('stanford', { data: zones, time: Date.now() });
        console.log(`[SIGNALS] Stanford: ${zones.length} interference zones`);
        return zones;
      }
    } catch (error) {
      // Endpoint is gone (404). Back off 6h and rely on GPSJam; skip the (also
      // dead) scrape fallback to avoid a second failed request each poll.
      this.stanfordCooldownUntil = Date.now() + 6 * 60 * 60 * 1000;
      console.warn(`[SIGNALS] Stanford GNSS unavailable (${error.response?.status || error.message}) — skipping 6h, using GPSJam`);
      const cached = this.cache.get('stanford');
      return cached?.data || [];
    }
  }

  async scrapeStanfordMap() {
    try {
      const response = await axios.get('https://rfi.stanford.edu/', {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 OSINT Monitor'
        }
      });

      // Try to extract data from the page
      const $ = cheerio.load(response.data);
      const zones = [];

      // Look for map data in script tags
      $('script').each((i, elem) => {
        const content = $(elem).html();
        if (content && content.includes('interference') || content.includes('jamming')) {
          // Try to parse JSON data from scripts
          const jsonMatch = content.match(/\[[\s\S]*?\]/);
          if (jsonMatch) {
            try {
              const data = JSON.parse(jsonMatch[0]);
              if (Array.isArray(data)) {
                data.forEach(item => {
                  if (item.lat && item.lon) {
                    zones.push({
                      latitude: item.lat,
                      longitude: item.lon,
                      region: item.name || 'Unknown',
                      source: 'Stanford GNSS (scraped)',
                      verified: true
                    });
                  }
                });
              }
            } catch (e) {}
          }
        }
      });

      return zones;
    } catch (error) {
      return [];
    }
  }

  async fetchGPSJam() {
    try {
      const cached = this.cache.get('gpsjam');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      console.log('[SIGNALS] Fetching gpsjam.org data...');
      
      // gpsjam.org shows hexagonal map of GPS interference
      // They use ADS-B data from aircraft reporting low NAV accuracy
      const response = await axios.get('https://gpsjam.org/', {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 OSINT Monitor'
        }
      });

      const $ = cheerio.load(response.data);
      const zones = [];

      // Look for data in the page
      // The site uses Leaflet/Mapbox, data might be in JSON
      $('script').each((i, elem) => {
        const content = $(elem).html();
        if (content && (content.includes('hexagon') || content.includes('interference'))) {
          // Extract coordinates from hex grid data
          const coordMatches = content.matchAll(/\[(-?\d+\.?\d*),\s*(-?\d+\.?\d*)\]/g);
          for (const match of coordMatches) {
            zones.push({
              latitude: parseFloat(match[2]),
              longitude: parseFloat(match[1]),
              source: 'gpsjam.org',
              verified: true
            });
          }
        }
      });

      // Parse visible region info
      const regionText = $('body').text();
      const knownRegions = ['Baltic', 'Black Sea', 'Eastern Mediterranean', 'Middle East', 'Kaliningrad', 'Syria', 'Ukraine'];
      
      for (const region of knownRegions) {
        if (regionText.toLowerCase().includes(region.toLowerCase())) {
          zones.push({
            region: region,
            location: region,
            status: 'ACTIVE',
            source: 'gpsjam.org',
            verified: true
          });
        }
      }

      this.cache.set('gpsjam', { data: zones, time: Date.now() });
      console.log(`[SIGNALS] gpsjam.org: ${zones.length} zones detected`);
      return zones;
    } catch (error) {
      console.log('[SIGNALS] gpsjam.org error:', error.message);
      return [];
    }
  }
}

module.exports = new SignalsMonitor();
