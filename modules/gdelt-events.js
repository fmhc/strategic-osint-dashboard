const axios = require('axios');
const OsintModule = require('./base-module');

/**
 * GDELT Event Database Module
 * 
 * Sources global events from GDELT Project with geo-coordinates, tone, and themes
 * API: GDELT 2.0 DOC API + GKG (Global Knowledge Graph)
 */

class GdeltEventsModule extends OsintModule {
  constructor() {
    super();
    this.name = 'gdelt-events';
    this.displayName = 'GDELT Global Events';
    this.icon = '🌍';
    this.category = 'intel';
    this.schedule = '*/10 * * * *';  // Every 10 minutes
    this.enabled = true;
    this.requiresEnv = [];
    
    this.cache = new Map();
    this.cacheTimeout = 600000; // 10 minutes — halves GDELT call rate vs the 5min cron (reduces 429s)
  }

  async update() {
    try {
      const [docEvents, gkgEvents] = await Promise.allSettled([
        this.fetchDocEvents(),
        this.fetchGKGEvents()
      ]);

      let allEvents = [];
      
      if (docEvents.status === 'fulfilled') {
        allEvents = [...allEvents, ...docEvents.value];
      }
      
      if (gkgEvents.status === 'fulfilled') {
        allEvents = [...allEvents, ...gkgEvents.value];
      }

      // Deduplicate and sort by tone/relevance
      const uniqueEvents = this.deduplicateEvents(allEvents);
      uniqueEvents.sort((a, b) => Math.abs(b.tone) - Math.abs(a.tone));

      return this.sanitizeData({
        timestamp: new Date(),
        count: uniqueEvents.length,
        events: uniqueEvents.slice(0, 50),
        summary: this.generateSummary(uniqueEvents),
        sources: {
          doc: docEvents.status === 'fulfilled' ? docEvents.value.length : 0,
          gkg: gkgEvents.status === 'fulfilled' ? gkgEvents.value.length : 0
        }
      });
    } catch (error) {
      console.error('[GDELT] Error:', error.message);
      return this.sanitizeData({
        timestamp: new Date(),
        count: 0,
        events: [],
        error: error.message
      });
    }
  }

  async fetchDocEvents() {
    try {
      const cached = this.cache.get('doc');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // GDELT 2.0 DOC API - Free, no auth required
      const query = 'conflict OR military OR tension OR missile OR attack OR strike';
      const response = await axios.get('http://api.gdeltproject.org/api/v2/doc/doc', {
        params: {
          query: query,
          mode: 'artlist',
          maxrecords: 30,
          format: 'json',
          timespan: '12h'
        },
        timeout: 15000
      });

      if (!response.data || !response.data.articles) {
        return [];
      }

      const events = response.data.articles.map(article => ({
        id: `doc_${article.url.slice(-20)}`,
        title: article.title,
        url: article.url,
        source: article.domain,
        tone: parseFloat(article.tone) || 0,
        timestamp: new Date(article.seendate),
        location: article.sourcecountry || 'Unknown',
        latitude: null, // DOC API doesn't provide coords
        longitude: null,
        themes: article.themes ? article.themes.split(';').slice(0, 3) : [],
        type: 'article',
        relevanceScore: Math.abs(parseFloat(article.tone) || 0),
        gdeltSource: 'DOC'
      }));

      this.cache.set('doc', { data: events, time: Date.now() });
      console.log(`[GDELT] DOC API: ${events.length} events`);
      return events;
    } catch (error) {
      const status = error.response?.status;
      const cached = this.cache.get('doc');
      if (status === 429 || status === 503) {
        console.warn(`[GDELT] DOC API ${status} (rate-limited) — serving cached data`);
      } else {
        console.error('[GDELT] DOC API error:', error.message);
      }
      return cached?.data || [];
    }
  }

  async fetchGKGEvents() {
    try {
      const cached = this.cache.get('gkg');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // GDELT GKG Timeline for country mentions
      const response = await axios.get('http://api.gdeltproject.org/api/v2/doc/doc', {
        params: {
          query: 'conflict',
          mode: 'TimelineSourceCountry',
          format: 'json',
          timespan: '6h'
        },
        timeout: 15000
      });

      if (!response.data || !response.data.timeline) {
        return [];
      }

      const events = response.data.timeline.map((item, index) => ({
        id: `gkg_${index}_${Date.now()}`,
        title: `${item.series} - ${item.value} mentions`,
        source: 'GDELT GKG',
        tone: 0, // GKG timeline doesn't provide tone
        timestamp: new Date(item.date),
        location: item.series || 'Global',
        latitude: null,
        longitude: null,
        themes: ['geopolitics', 'country_mentions'],
        type: 'timeline',
        relevanceScore: parseInt(item.value) || 0,
        gdeltSource: 'GKG',
        value: parseInt(item.value) || 0
      }));

      this.cache.set('gkg', { data: events, time: Date.now() });
      console.log(`[GDELT] GKG API: ${events.length} timeline events`);
      return events;
    } catch (error) {
      const status = error.response?.status;
      const cached = this.cache.get('gkg');
      if (status === 429 || status === 503) {
        console.warn(`[GDELT] GKG API ${status} (rate-limited) — serving cached data`);
      } else {
        console.error('[GDELT] GKG API error:', error.message);
      }
      return cached?.data || [];
    }
  }

  deduplicateEvents(events) {
    const seen = new Map();
    
    for (const event of events) {
      // Use title + source as key for deduplication
      const key = `${event.title.substring(0, 50)}_${event.source}`;
      
      if (!seen.has(key) || event.relevanceScore > seen.get(key).relevanceScore) {
        seen.set(key, event);
      }
    }
    
    return Array.from(seen.values());
  }

  generateSummary(events) {
    const bySource = {};
    const byLocation = {};
    const topThemes = {};
    let totalTone = 0;
    let toneCount = 0;

    events.forEach(event => {
      // By source
      bySource[event.gdeltSource] = (bySource[event.gdeltSource] || 0) + 1;
      
      // By location
      if (event.location && event.location !== 'Unknown') {
        byLocation[event.location] = (byLocation[event.location] || 0) + 1;
      }
      
      // Themes
      event.themes.forEach(theme => {
        topThemes[theme] = (topThemes[theme] || 0) + 1;
      });
      
      // Average tone
      if (event.tone !== 0) {
        totalTone += event.tone;
        toneCount++;
      }
    });

    return {
      total: events.length,
      sources: bySource,
      topLocations: Object.entries(byLocation)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([loc, count]) => ({ location: loc, count })),
      topThemes: Object.entries(topThemes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([theme, count]) => ({ theme, count })),
      averageTone: toneCount > 0 ? (totalTone / toneCount).toFixed(2) : 0,
      toneAnalysis: toneCount > 0 ? (totalTone / toneCount > 0 ? 'Positive' : 'Negative') : 'Neutral'
    };
  }

  getDefaultState() {
    return {
      timestamp: null,
      count: 0,
      events: [],
      summary: {
        total: 0,
        sources: {},
        topLocations: [],
        topThemes: [],
        averageTone: 0,
        toneAnalysis: 'Neutral'
      }
    };
  }

  getAlerts(data) {
    const alerts = [];
    
    // Alert on high negative tone events
    if (data.events) {
      const highNegativeTone = data.events.filter(e => e.tone < -5).length;
      if (highNegativeTone > 5) {
        alerts.push({
          id: `gdelt_negative_tone_${Date.now()}`,
          type: 'GDELT',
          severity: 'HIGH',
          message: `High negative tone detected in ${highNegativeTone} global events`,
          timestamp: new Date(),
          data: { negativeEvents: highNegativeTone }
        });
      }
    }
    
    return alerts;
  }
}

module.exports = new GdeltEventsModule();
