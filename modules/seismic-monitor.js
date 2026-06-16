const axios = require('axios');

/**
 * Seismic Monitor Module - NUR ECHTE DATEN
 * 
 * ECHTE Datenquellen:
 * - USGS Earthquake API (US Geological Survey) ✓
 * - EMSC (European-Mediterranean Seismological Centre) ✓
 * 
 * HINWEIS: Die "Man-Made" Analyse wurde ENTFERNT!
 * Grund: Algorithmus kann nicht zuverlässig zwischen 
 * natürlichen und künstlichen Ereignissen unterscheiden.
 * Das ist Aufgabe von CTBTO (Comprehensive Nuclear-Test-Ban Treaty Organization)
 */

class SeismicMonitor {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 120000; // 2 minutes
  }

  async monitorSeismicActivity() {
    try {
      const [usgsData, emscData] = await Promise.allSettled([
        this.fetchUSGS(),
        this.fetchEMSC()
      ]);

      let allEvents = [];
      
      if (usgsData.status === 'fulfilled') {
        allEvents = [...allEvents, ...usgsData.value];
      }
      
      if (emscData.status === 'fulfilled') {
        allEvents = [...allEvents, ...emscData.value];
      }

      // Deduplicate by time and location
      const uniqueEvents = this.deduplicateEvents(allEvents);
      
      // Sort by magnitude (most significant first)
      uniqueEvents.sort((a, b) => b.magnitude - a.magnitude);

      return {
        timestamp: new Date(),
        count: uniqueEvents.length,
        events: uniqueEvents.slice(0, 50),
        summary: this.generateSummary(uniqueEvents),
        alerts: [], // Keine spekulativen Alerts mehr
        sources: {
          usgs: usgsData.status === 'fulfilled' ? usgsData.value.length : 0,
          emsc: emscData.status === 'fulfilled' ? emscData.value.length : 0
        },
        dataSource: {
          verified: true,
          sources: ['USGS Earthquake API', 'EMSC Seismic Portal'],
          note: 'Alle Daten sind offizielle seismologische Messwerte'
        }
      };
    } catch (error) {
      console.error('[SEISMIC] Error:', error.message);
      return {
        timestamp: new Date(),
        count: 0,
        events: [],
        summary: {},
        error: error.message
      };
    }
  }

  async fetchUSGS() {
    try {
      const cached = this.cache.get('usgs');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // USGS Earthquake API - FREE, no auth required
      const endTime = new Date().toISOString();
      const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      
      const response = await axios.get('https://earthquake.usgs.gov/fdsnws/event/1/query', {
        params: {
          format: 'geojson',
          starttime: startTime,
          endtime: endTime,
          minmagnitude: 2.5,
          orderby: 'time'
        },
        timeout: 15000
      });

      if (!response.data || !response.data.features) {
        return [];
      }

      const events = response.data.features.map(f => ({
        id: f.id,
        time: new Date(f.properties.time),
        magnitude: f.properties.mag,
        magnitudeType: f.properties.magType,
        depth: f.geometry.coordinates[2],
        latitude: f.geometry.coordinates[1],
        longitude: f.geometry.coordinates[0],
        place: f.properties.place,
        type: f.properties.type,
        tsunami: f.properties.tsunami,
        source: 'USGS',
        url: f.properties.url,
        verified: true
      }));

      this.cache.set('usgs', { data: events, time: Date.now() });
      console.log(`[SEISMIC] USGS: ${events.length} events`);
      return events;
    } catch (error) {
      console.error('[SEISMIC] USGS error:', error.message);
      return [];
    }
  }

  async fetchEMSC() {
    try {
      const cached = this.cache.get('emsc');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      const response = await axios.get('https://www.seismicportal.eu/fdsnws/event/1/query', {
        params: {
          format: 'json',
          limit: 100,
          minmag: 2.5,
          orderby: 'time'
        },
        timeout: 15000
      });

      if (!response.data || !response.data.features) {
        return [];
      }

      const events = response.data.features.map(f => ({
        id: f.id,
        time: new Date(f.properties.time),
        magnitude: f.properties.mag,
        magnitudeType: f.properties.magtype,
        depth: f.properties.depth,
        latitude: f.properties.lat,
        longitude: f.properties.lon,
        place: f.properties.flynn_region,
        type: 'earthquake',
        source: 'EMSC',
        url: f.properties.unid ? `https://www.emsc-csem.org/Earthquake/earthquake.php?id=${f.properties.unid}` : null,
        verified: true
      }));

      this.cache.set('emsc', { data: events, time: Date.now() });
      console.log(`[SEISMIC] EMSC: ${events.length} events`);
      return events;
    } catch (error) {
      console.error('[SEISMIC] EMSC error:', error.message);
      return [];
    }
  }

  deduplicateEvents(events) {
    const seen = new Map();
    
    for (const event of events) {
      const key = `${Math.round(event.latitude * 10)}_${Math.round(event.longitude * 10)}_${Math.round(event.time.getTime() / 60000)}`;
      
      if (!seen.has(key) || event.magnitude > seen.get(key).magnitude) {
        seen.set(key, event);
      }
    }
    
    return Array.from(seen.values());
  }

  generateSummary(events) {
    return {
      total: events.length,
      byMagnitude: {
        'minor (2.5-4.0)': events.filter(e => e.magnitude >= 2.5 && e.magnitude < 4.0).length,
        'light (4.0-5.0)': events.filter(e => e.magnitude >= 4.0 && e.magnitude < 5.0).length,
        'moderate (5.0-6.0)': events.filter(e => e.magnitude >= 5.0 && e.magnitude < 6.0).length,
        'strong (6.0+)': events.filter(e => e.magnitude >= 6.0).length
      },
      maxMagnitude: events.length > 0 ? Math.max(...events.map(e => e.magnitude)) : 0,
      latestEvent: events.length > 0 ? events[0] : null
    };
  }
}

module.exports = new SeismicMonitor();
