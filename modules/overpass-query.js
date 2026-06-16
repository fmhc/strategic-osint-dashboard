const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Overpass Query Module
 *
 * Fetches strategic infrastructure data from OpenStreetMap via Overpass API.
 * Focuses on German military airbases, harbours, and naval installations.
 */

class OverpassQuery {
  constructor() {
    this.apiEndpoints = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
    ];
    this.currentEndpoint = 0;
    this.timeout = 60000;
    this.cachePath = path.join(__dirname, '..', 'data', 'german-infrastructure.json');
    this.cache = null;
    this.cacheMaxAge = 24 * 60 * 60 * 1000; // 24 hours
    this.loadCache();
  }

  /**
   * Load cached data
   */
  loadCache() {
    try {
      if (fs.existsSync(this.cachePath)) {
        const data = fs.readFileSync(this.cachePath, 'utf8');
        this.cache = JSON.parse(data);
        console.log('[OVERPASS] Loaded cached infrastructure data');
        return true;
      }
    } catch (error) {
      console.error('[OVERPASS] Error loading cache:', error.message);
    }
    return false;
  }

  /**
   * Save data to cache
   */
  saveCache(data) {
    try {
      data.lastUpdate = new Date().toISOString();
      fs.writeFileSync(this.cachePath, JSON.stringify(data, null, 2));
      this.cache = data;
      console.log('[OVERPASS] Saved infrastructure data to cache');
    } catch (error) {
      console.error('[OVERPASS] Error saving cache:', error.message);
    }
  }

  /**
   * Get API endpoint with fallback
   */
  getEndpoint() {
    return this.apiEndpoints[this.currentEndpoint % this.apiEndpoints.length];
  }

  /**
   * Switch to next endpoint on failure
   */
  nextEndpoint() {
    this.currentEndpoint++;
    console.log(`[OVERPASS] Switching to endpoint: ${this.getEndpoint()}`);
  }

  /**
   * Execute Overpass query
   */
  async executeQuery(query) {
    const maxRetries = this.apiEndpoints.length;

    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        const endpoint = this.getEndpoint();
        console.log(`[OVERPASS] Querying ${endpoint}`);

        const response = await axios.post(endpoint, `data=${encodeURIComponent(query)}`, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: this.timeout
        });

        return response.data;
      } catch (error) {
        console.error(`[OVERPASS] Query failed: ${error.message}`);
        this.nextEndpoint();

        if (retry === maxRetries - 1) {
          throw error;
        }
      }
    }
  }

  /**
   * Query for German military airbases
   */
  async queryGermanAirbases() {
    const query = `
      [out:json][timeout:60];
      area["ISO3166-1"="DE"]->.germany;
      (
        // Military airfields
        node["aeroway"="aerodrome"]["military"="airfield"](area.germany);
        way["aeroway"="aerodrome"]["military"="airfield"](area.germany);
        node["military"="airfield"](area.germany);
        way["military"="airfield"](area.germany);

        // Known NATO/German bases by name
        node["name"~"Ramstein|Spangdahlem|Büchel|Geilenkirchen|Jagel|Wunstorf|Nörvenich|Lechfeld|Neuburg|Laage",i](area.germany);
        way["name"~"Ramstein|Spangdahlem|Büchel|Geilenkirchen|Jagel|Wunstorf|Nörvenich|Lechfeld|Neuburg|Laage",i](area.germany);

        // Air force installations
        node["military"="barracks"]["operator"~"Luftwaffe|USAF|NATO",i](area.germany);
        way["military"="barracks"]["operator"~"Luftwaffe|USAF|NATO",i](area.germany);
      );
      out center;
    `;

    try {
      const result = await this.executeQuery(query);
      return this.parseAirbases(result);
    } catch (error) {
      console.error('[OVERPASS] Airbases query failed:', error.message);
      return this.cache?.airbases || [];
    }
  }

  /**
   * Parse airbase results
   */
  parseAirbases(data) {
    const airbases = [];
    const seen = new Set();

    if (!data?.elements) return airbases;

    for (const element of data.elements) {
      const name = element.tags?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const lat = element.lat || element.center?.lat;
      const lon = element.lon || element.center?.lon;

      if (!lat || !lon) continue;

      airbases.push({
        id: element.id,
        name,
        lat,
        lon,
        type: this.classifyAirbase(name, element.tags),
        operator: element.tags?.operator || this.guessOperator(name),
        icao: element.tags?.icao || null,
        iata: element.tags?.iata || null,
        source: 'osm_overpass'
      });
    }

    return airbases;
  }

  /**
   * Classify airbase type
   */
  classifyAirbase(name, tags) {
    const nameLower = name.toLowerCase();

    if (nameLower.includes('ramstein')) return 'nato_major';
    if (nameLower.includes('spangdahlem')) return 'nato_fighter';
    if (nameLower.includes('büchel')) return 'nato_nuclear';
    if (nameLower.includes('geilenkirchen')) return 'nato_awacs';

    if (tags?.operator?.toLowerCase().includes('usaf')) return 'usaf';
    if (tags?.operator?.toLowerCase().includes('nato')) return 'nato';
    if (tags?.operator?.toLowerCase().includes('luftwaffe')) return 'luftwaffe';

    return 'military';
  }

  /**
   * Guess operator from name
   */
  guessOperator(name) {
    const nameLower = name.toLowerCase();

    if (nameLower.includes('ramstein') || nameLower.includes('spangdahlem')) return 'USAF';
    if (nameLower.includes('geilenkirchen')) return 'NATO';
    if (nameLower.includes('fliegerhorst')) return 'Luftwaffe';

    return 'Unknown';
  }

  /**
   * Query for German harbours and ports
   */
  async queryGermanHarbours() {
    const query = `
      [out:json][timeout:60];
      area["ISO3166-1"="DE"]->.germany;
      (
        // Harbours and ports
        node["harbour"="yes"](area.germany);
        way["harbour"="yes"](area.germany);
        node["landuse"="port"](area.germany);
        way["landuse"="port"](area.germany);

        // Major ports by name
        node["name"~"Hamburg.*Hafen|Bremerhaven|Wilhelmshaven|Kiel.*Hafen|Rostock.*Hafen|Lübeck.*Hafen|Cuxhaven|Brunsbüttel",i](area.germany);
        way["name"~"Hamburg.*Hafen|Bremerhaven|Wilhelmshaven|Kiel.*Hafen|Rostock.*Hafen|Lübeck.*Hafen|Cuxhaven|Brunsbüttel",i](area.germany);

        // Industrial ports
        node["industrial"="port"](area.germany);
        way["industrial"="port"](area.germany);
      );
      out center;
    `;

    try {
      const result = await this.executeQuery(query);
      return this.parseHarbours(result);
    } catch (error) {
      console.error('[OVERPASS] Harbours query failed:', error.message);
      return this.cache?.harbours || [];
    }
  }

  /**
   * Parse harbour results
   */
  parseHarbours(data) {
    const harbours = [];
    const seen = new Set();

    if (!data?.elements) return harbours;

    for (const element of data.elements) {
      const name = element.tags?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const lat = element.lat || element.center?.lat;
      const lon = element.lon || element.center?.lon;

      if (!lat || !lon) continue;

      harbours.push({
        id: element.id,
        name,
        lat,
        lon,
        type: this.classifyHarbour(name, element.tags),
        source: 'osm_overpass'
      });
    }

    return harbours;
  }

  /**
   * Classify harbour type
   */
  classifyHarbour(name, tags) {
    const nameLower = name.toLowerCase();

    if (nameLower.includes('container')) return 'container';
    if (nameLower.includes('cruise')) return 'cruise';
    if (nameLower.includes('ferry') || nameLower.includes('fähre')) return 'ferry';
    if (nameLower.includes('lng') || nameLower.includes('öl')) return 'energy';
    if (nameLower.includes('fish')) return 'fishing';

    if (nameLower.includes('hamburg') || nameLower.includes('bremerhaven')) return 'major_port';
    if (nameLower.includes('wilhelmshaven')) return 'deep_water_port';

    return 'port';
  }

  /**
   * Query for German naval bases
   */
  async queryGermanNavalBases() {
    const query = `
      [out:json][timeout:60];
      area["ISO3166-1"="DE"]->.germany;
      (
        // Naval bases
        node["military"="naval_base"](area.germany);
        way["military"="naval_base"](area.germany);

        // Marine installations by name
        node["name"~"Marinestützpunkt|Marinehafen|Marine.*Kaserne",i](area.germany);
        way["name"~"Marinestützpunkt|Marinehafen|Marine.*Kaserne",i](area.germany);

        // Known naval locations
        node["name"~"Eckernförde|Wilhelmshaven.*Marine|Kiel.*Marine|Warnemünde.*Marine",i](area.germany);
        way["name"~"Eckernförde|Wilhelmshaven.*Marine|Kiel.*Marine|Warnemünde.*Marine",i](area.germany);
      );
      out center;
    `;

    try {
      const result = await this.executeQuery(query);
      return this.parseNavalBases(result);
    } catch (error) {
      console.error('[OVERPASS] Naval bases query failed:', error.message);
      return this.cache?.naval_bases || [];
    }
  }

  /**
   * Parse naval base results
   */
  parseNavalBases(data) {
    const bases = [];
    const seen = new Set();

    if (!data?.elements) return bases;

    for (const element of data.elements) {
      const name = element.tags?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const lat = element.lat || element.center?.lat;
      const lon = element.lon || element.center?.lon;

      if (!lat || !lon) continue;

      bases.push({
        id: element.id,
        name,
        lat,
        lon,
        type: 'naval_base',
        operator: 'Deutsche Marine',
        source: 'osm_overpass'
      });
    }

    return bases;
  }

  /**
   * Query for Hamburg port infrastructure
   */
  async queryHamburgInfrastructure() {
    const query = `
      [out:json][timeout:60];
      area["name"="Hamburg"]->.hh;
      (
        // Port terminals
        way["landuse"="port"](area.hh);
        node["harbour"="yes"](area.hh);

        // Container terminals
        node["name"~"Container.*Terminal|HHLA|Eurogate",i](area.hh);
        way["name"~"Container.*Terminal|HHLA|Eurogate",i](area.hh);

        // Cruise terminals
        node["name"~"Cruise|Kreuzfahrt",i](area.hh);
        way["name"~"Cruise|Kreuzfahrt",i](area.hh);

        // Shipyards
        node["name"~"Blohm|Werft|Dock",i](area.hh);
        way["name"~"Blohm|Werft|Dock",i](area.hh);

        // Industrial areas
        way["landuse"="industrial"]["name"](area.hh);
      );
      out center;
    `;

    try {
      const result = await this.executeQuery(query);
      return this.parseHamburgInfra(result);
    } catch (error) {
      console.error('[OVERPASS] Hamburg query failed:', error.message);
      return this.cache?.hamburg_specific?.port_zones || [];
    }
  }

  /**
   * Parse Hamburg infrastructure results
   */
  parseHamburgInfra(data) {
    const infra = [];
    const seen = new Set();

    if (!data?.elements) return infra;

    for (const element of data.elements) {
      const name = element.tags?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const lat = element.lat || element.center?.lat;
      const lon = element.lon || element.center?.lon;

      if (!lat || !lon) continue;

      infra.push({
        id: element.id,
        name,
        lat,
        lon,
        type: this.classifyHamburgInfra(name, element.tags),
        source: 'osm_overpass'
      });
    }

    return infra;
  }

  /**
   * Classify Hamburg infrastructure type
   */
  classifyHamburgInfra(name, tags) {
    const nameLower = name.toLowerCase();

    if (nameLower.includes('container')) return 'container';
    if (nameLower.includes('cruise') || nameLower.includes('kreuzfahrt')) return 'cruise';
    if (nameLower.includes('blohm') || nameLower.includes('werft')) return 'shipyard';
    if (nameLower.includes('terminal')) return 'terminal';

    return 'infrastructure';
  }

  /**
   * Refresh all German infrastructure data
   */
  async refreshAll() {
    console.log('[OVERPASS] Refreshing all German infrastructure data...');

    try {
      // allSettled so one failing Overpass query keeps the other infrastructure layers
      const _settled = await Promise.allSettled([
        this.queryGermanAirbases(),
        this.queryGermanHarbours(),
        this.queryGermanNavalBases(),
        this.queryHamburgInfrastructure()
      ]);
      const _labels = ['airbases', 'harbours', 'naval bases', 'Hamburg infra'];
      _settled.forEach((r, i) => { if (r.status === 'rejected') console.warn(`[OVERPASS] ${_labels[i]} query failed:`, r.reason?.message || r.reason); });
      const [airbases, harbours, navalBases, hamburgInfra] =
        _settled.map(r => (r.status === 'fulfilled' ? r.value : []));

      // Merge with existing cache data (keep curated entries, add OSM data)
      const existingData = this.cache || {};

      const updatedData = {
        ...existingData,
        lastUpdate: new Date().toISOString(),
        source: 'OpenStreetMap Overpass API',
        osm_airbases: airbases,
        osm_harbours: harbours,
        osm_naval_bases: navalBases,
        osm_hamburg: hamburgInfra,
        // Keep curated data but mark as merged
        merged: true
      };

      this.saveCache(updatedData);

      return {
        success: true,
        timestamp: new Date(),
        counts: {
          airbases: airbases.length,
          harbours: harbours.length,
          navalBases: navalBases.length,
          hamburgInfra: hamburgInfra.length
        }
      };
    } catch (error) {
      console.error('[OVERPASS] Refresh failed:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date()
      };
    }
  }

  /**
   * Get all infrastructure (cached + OSM)
   */
  getAllInfrastructure() {
    if (!this.cache) {
      this.loadCache();
    }

    return {
      timestamp: this.cache?.lastUpdate || null,
      airbases: [...(this.cache?.airbases || []), ...(this.cache?.osm_airbases || [])],
      harbours: [...(this.cache?.harbours || []), ...(this.cache?.osm_harbours || [])],
      naval_bases: [...(this.cache?.naval_bases || []), ...(this.cache?.osm_naval_bases || [])],
      hamburg: this.cache?.hamburg_specific || {},
      critical_infrastructure: this.cache?.critical_infrastructure || []
    };
  }

  /**
   * Get airbases only
   */
  getAirbases() {
    const infra = this.getAllInfrastructure();
    return infra.airbases;
  }

  /**
   * Get harbours only
   */
  getHarbours() {
    const infra = this.getAllInfrastructure();
    return infra.harbours;
  }

  /**
   * Get naval bases only
   */
  getNavalBases() {
    const infra = this.getAllInfrastructure();
    return infra.naval_bases;
  }

  /**
   * Check if cache needs refresh
   */
  needsRefresh() {
    if (!this.cache?.lastUpdate) return true;

    const lastUpdate = new Date(this.cache.lastUpdate);
    const age = Date.now() - lastUpdate.getTime();

    return age > this.cacheMaxAge;
  }
}

module.exports = new OverpassQuery();
