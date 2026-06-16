const axios = require('axios');

/**
 * GDACS Monitor — Global Disaster Alert and Coordination System (UN/EC).
 * Free, no-auth, multi-hazard disaster alerts (earthquakes, tropical cyclones,
 * floods, volcanoes, droughts, wildfires) as GeoJSON with severity + coordinates.
 * https://www.gdacs.org
 *
 * Auto-integrates via the module loader: the `update()` method is detected and
 * scheduled, data is stored under globalState['gdacs-monitor'] and exposed at
 * GET /api/gdacs-monitor + broadcast as 'gdacs-monitor-update'.
 */
const GDACS_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP';

const TYPE_LABELS = { EQ: 'Earthquake', TC: 'Tropical Cyclone', FL: 'Flood', VO: 'Volcano', DR: 'Drought', WF: 'Wildfire' };
const ALERT_SEVERITY = { Red: 'CRITICAL', Orange: 'HIGH', Green: 'LOW' };

class GdacsMonitor {
  constructor() {
    this.cache = null;
    this.cacheTime = 0;
    this.cacheTimeout = 10 * 60 * 1000; // 10 min — GDACS updates a few times/hour
  }

  async update() {
    const now = Date.now();
    if (this.cache && now - this.cacheTime < this.cacheTimeout) return this.cache;
    try {
      const res = await axios.get(GDACS_URL, {
        timeout: 15000,
        headers: { 'User-Agent': 'OSINT-Dashboard/1.0' }
      });
      const features = res.data?.features || [];
      const events = features.map(f => {
        const p = f.properties || {};
        const coords = f.geometry?.coordinates || [];
        return {
          id: `gdacs_${p.eventtype}_${p.eventid}`,
          eventType: TYPE_LABELS[p.eventtype] || p.eventtype,
          typeCode: p.eventtype,
          name: p.name || p.eventname || '',
          country: p.country || 'Unknown',
          alertLevel: p.alertlevel || 'Green',
          severity: ALERT_SEVERITY[p.alertlevel] || 'LOW',
          longitude: coords[0] ?? null,
          latitude: coords[1] ?? null,
          isCurrent: !!p.iscurrent,
          url: `https://www.gdacs.org/report.aspx?eventtype=${p.eventtype}&eventid=${p.eventid}`,
          timestamp: new Date()
        };
      });
      const data = {
        timestamp: new Date(),
        count: events.length,
        events,
        summary: this.summarize(events)
      };
      this.cache = data;
      this.cacheTime = now;
      console.log(`[GDACS] ${events.length} disaster events (${data.summary.byAlert.Red || 0} red, ${data.summary.byAlert.Orange || 0} orange)`);
      return data;
    } catch (e) {
      console.warn('[GDACS] fetch failed:', e.response?.status || e.message);
      return this.cache || { timestamp: new Date(), count: 0, events: [], summary: {} };
    }
  }

  summarize(events) {
    const byAlert = {}, byType = {};
    for (const e of events) {
      byAlert[e.alertLevel] = (byAlert[e.alertLevel] || 0) + 1;
      byType[e.eventType] = (byType[e.eventType] || 0) + 1;
    }
    return { total: events.length, byAlert, byType };
  }

  getDefaultState() {
    return { timestamp: null, count: 0, events: [], summary: {} };
  }

  getAlerts(data) {
    return (data?.events || [])
      .filter(e => e.severity === 'CRITICAL' || e.severity === 'HIGH')
      .slice(0, 10)
      .map(e => ({ source: 'GDACS', severity: e.severity, message: `${e.eventType}: ${e.name} (${e.country})` }));
  }
}

module.exports = new GdacsMonitor();
