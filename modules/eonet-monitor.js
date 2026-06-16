const axios = require('axios');

/**
 * EONET Monitor — NASA Earth Observatory Natural Event Tracker (v3).
 * Free, no-auth JSON of currently-open, satellite-tracked natural events
 * (wildfires, severe storms, volcanoes, sea/lake ice, dust/haze, …) with source
 * attribution and per-event track points. Complements GDACS (alert-level summaries)
 * with NASA-derived individual named events. https://eonet.gsfc.nasa.gov
 *
 * Auto-integrates via the loader: `update()` is detected and scheduled, data is
 * stored under globalState['eonet-monitor'] and exposed at GET /api/eonet-monitor.
 */
const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=100';

class EonetMonitor {
  constructor() {
    this.cache = null;
    this.cacheTime = 0;
    this.cacheTimeout = 30 * 60 * 1000; // 30 min — EONET updates a few times/day
  }

  async update() {
    const now = Date.now();
    if (this.cache && now - this.cacheTime < this.cacheTimeout) return this.cache;
    try {
      const res = await axios.get(EONET_URL, {
        timeout: 15000,
        headers: { 'User-Agent': 'OSINT-Dashboard/1.0' }
      });
      const raw = res.data?.events || [];
      const events = raw.map(e => {
        const geoms = Array.isArray(e.geometry) ? e.geometry : [];
        const last = geoms.length ? geoms[geoms.length - 1] : null;
        let lon = null, lat = null;
        if (last && last.type === 'Point' && Array.isArray(last.coordinates)) {
          lon = last.coordinates[0];
          lat = last.coordinates[1];
        }
        return {
          id: e.id,
          title: e.title,
          category: e.categories?.[0]?.title || 'Unknown',
          date: last?.date || null,
          longitude: lon,
          latitude: lat,
          source: e.sources?.[0]?.id || 'EONET',
          url: e.link || e.sources?.[0]?.url || null
        };
      }).filter(e => e.latitude != null && e.longitude != null);

      const data = {
        timestamp: new Date(),
        count: events.length,
        events,
        summary: this.summarize(events)
      };
      this.cache = data;
      this.cacheTime = now;
      console.log(`[EONET] ${events.length} open natural events`);
      return data;
    } catch (e) {
      console.warn('[EONET] fetch failed:', e.response?.status || e.message);
      return this.cache || { timestamp: new Date(), count: 0, events: [], summary: {} };
    }
  }

  summarize(events) {
    const byCategory = {};
    for (const e of events) byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    return { total: events.length, byCategory };
  }

  getDefaultState() {
    return { timestamp: null, count: 0, events: [], summary: {} };
  }

  // Surface the higher-interest natural events as dashboard alerts (EONET has no
  // severity field, so we flag by category). Wildfires are too numerous to alert on.
  getAlerts(data) {
    const notable = { Volcanoes: 'HIGH', 'Severe Storms': 'MEDIUM' };
    return (data?.events || [])
      .filter(e => notable[e.category])
      .slice(0, 10)
      .map(e => ({ source: 'EONET', severity: notable[e.category], message: `${e.category}: ${e.title}` }));
  }
}

module.exports = new EonetMonitor();
