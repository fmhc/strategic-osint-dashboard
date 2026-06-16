const axios = require('axios');

/**
 * Offshore Platforms Module
 * Tracks oil rigs, gas platforms, and other offshore installations worldwide
 *
 * Data Sources:
 * - BOEM (Bureau of Ocean Energy Management) - US Gulf of Mexico & Pacific
 * - OGIM (Oil and Gas Infrastructure Mapping) - Global coverage
 */

class OffshorePlatforms {
  constructor() {
    this.platforms = [];
    this.lastUpdate = null;
    this.cache = {
      boem: { data: null, timestamp: null },
      global: { data: null, timestamp: null }
    };
    this.CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours - platforms don't move
  }

  /**
   * Fetch US platforms from BOEM ArcGIS REST API
   */
  async fetchBOEMPlatforms() {
    // Check cache
    if (this.cache.boem.data &&
        Date.now() - this.cache.boem.timestamp < this.CACHE_TTL) {
      return this.cache.boem.data;
    }

    try {
      // BOEM MapServer - OCS Drilling Platforms layer
      const url = 'https://gis.boem.gov/arcgis/rest/services/BOEM_BSEE/MMC_Layers/MapServer/0/query';
      const params = {
        where: '1=1',
        outFields: '*',
        f: 'geojson',
        resultRecordCount: 5000
      };

      const response = await axios.get(url, { params, timeout: 30000 });

      if (response.data && response.data.features) {
        const platforms = response.data.features.map(f => ({
          id: `boem-${f.properties.COMPLEX_ID || f.properties.OBJECTID}`,
          name: f.properties.COMPLEX_NAME || f.properties.STRUCTURE_NAME || 'Unknown Platform',
          type: this.classifyPlatformType(f.properties),
          latitude: f.geometry.coordinates[1],
          longitude: f.geometry.coordinates[0],
          region: 'US Gulf of Mexico',
          country: 'USA',
          operator: f.properties.OPERATOR || 'Unknown',
          installDate: f.properties.INSTALL_DATE || null,
          waterDepth: f.properties.WATER_DEPTH_M || f.properties.WATER_DEPTH || null,
          status: f.properties.STATUS || 'Active',
          source: 'BOEM',
          properties: f.properties
        }));

        this.cache.boem = { data: platforms, timestamp: Date.now() };
        console.log(`[OFFSHORE] Fetched ${platforms.length} BOEM platforms`);
        return platforms;
      }
      return [];
    } catch (error) {
      console.error('[OFFSHORE] BOEM fetch error:', error.message);
      // Return cached data if available, even if stale
      return this.cache.boem.data || [];
    }
  }

  /**
   * Fetch global platforms data
   * Using a curated list of major offshore installations
   */
  async fetchGlobalPlatforms() {
    // Check cache
    if (this.cache.global.data &&
        Date.now() - this.cache.global.timestamp < this.CACHE_TTL) {
      return this.cache.global.data;
    }

    // Major global offshore platforms (curated data)
    // In production, this could be enhanced with OGIM database or other sources
    const globalPlatforms = [
      // North Sea - UK
      { id: 'uk-forties-alpha', name: 'Forties Alpha', type: 'Oil Platform', latitude: 57.717, longitude: 0.983, region: 'North Sea', country: 'UK', operator: 'Apache' },
      { id: 'uk-brent-charlie', name: 'Brent Charlie', type: 'Oil Platform', latitude: 61.05, longitude: 1.717, region: 'North Sea', country: 'UK', operator: 'Shell' },
      { id: 'uk-buzzard', name: 'Buzzard Platform', type: 'Oil Platform', latitude: 57.483, longitude: 0.117, region: 'North Sea', country: 'UK', operator: 'CNOOC' },

      // North Sea - Norway
      { id: 'no-troll-a', name: 'Troll A', type: 'Gas Platform', latitude: 60.645, longitude: 3.726, region: 'North Sea', country: 'Norway', operator: 'Equinor', notes: 'Tallest structure ever moved by mankind' },
      { id: 'no-oseberg', name: 'Oseberg A', type: 'Oil Platform', latitude: 60.493, longitude: 2.816, region: 'North Sea', country: 'Norway', operator: 'Equinor' },
      { id: 'no-gullfaks', name: 'Gullfaks A', type: 'Oil Platform', latitude: 61.173, longitude: 2.118, region: 'North Sea', country: 'Norway', operator: 'Equinor' },
      { id: 'no-ekofisk', name: 'Ekofisk Complex', type: 'Oil Platform', latitude: 56.545, longitude: 3.211, region: 'North Sea', country: 'Norway', operator: 'ConocoPhillips' },
      { id: 'no-snorre', name: 'Snorre A', type: 'Oil Platform', latitude: 61.452, longitude: 2.15, region: 'North Sea', country: 'Norway', operator: 'Equinor' },

      // Brazil - Pre-salt
      { id: 'br-p-70', name: 'P-70 FPSO', type: 'FPSO', latitude: -25.3, longitude: -42.9, region: 'Santos Basin', country: 'Brazil', operator: 'Petrobras' },
      { id: 'br-p-67', name: 'P-67 FPSO', type: 'FPSO', latitude: -25.1, longitude: -42.7, region: 'Santos Basin', country: 'Brazil', operator: 'Petrobras' },
      { id: 'br-lula', name: 'Lula FPSO', type: 'FPSO', latitude: -25.35, longitude: -43.05, region: 'Santos Basin', country: 'Brazil', operator: 'Petrobras', notes: 'Giant pre-salt field' },

      // Persian Gulf
      { id: 'sa-safaniya', name: 'Safaniya Platform', type: 'Oil Platform', latitude: 28.2, longitude: 49.1, region: 'Persian Gulf', country: 'Saudi Arabia', operator: 'Saudi Aramco', notes: 'Largest offshore oil field' },
      { id: 'qa-north-dome', name: 'North Dome Platform', type: 'Gas Platform', latitude: 26.0, longitude: 52.0, region: 'Persian Gulf', country: 'Qatar', operator: 'Qatar Petroleum', notes: 'Largest gas field' },
      { id: 'ae-umm-shaif', name: 'Umm Shaif Platform', type: 'Oil Platform', latitude: 25.05, longitude: 53.0, region: 'Persian Gulf', country: 'UAE', operator: 'ADNOC' },
      { id: 'ir-south-pars', name: 'South Pars Platform', type: 'Gas Platform', latitude: 26.8, longitude: 52.5, region: 'Persian Gulf', country: 'Iran', operator: 'NIOC' },

      // West Africa
      { id: 'ng-bonga', name: 'Bonga FPSO', type: 'FPSO', latitude: 4.55, longitude: 4.2, region: 'Niger Delta', country: 'Nigeria', operator: 'Shell' },
      { id: 'ao-dalia', name: 'Dalia FPSO', type: 'FPSO', latitude: -7.5, longitude: 12.0, region: 'Angola Block 17', country: 'Angola', operator: 'TotalEnergies' },
      { id: 'ao-kaombo', name: 'Kaombo FPSO', type: 'FPSO', latitude: -7.8, longitude: 11.8, region: 'Angola Block 32', country: 'Angola', operator: 'TotalEnergies' },

      // Southeast Asia
      { id: 'my-petronas-1', name: 'Petronas Carigali Platform', type: 'Oil Platform', latitude: 5.5, longitude: 114.5, region: 'South China Sea', country: 'Malaysia', operator: 'Petronas' },
      { id: 'id-tangguh', name: 'Tangguh LNG Platform', type: 'LNG Platform', latitude: -2.6, longitude: 132.8, region: 'Papua', country: 'Indonesia', operator: 'BP' },
      { id: 'au-gorgon', name: 'Gorgon LNG Platform', type: 'LNG Platform', latitude: -20.52, longitude: 115.6, region: 'Northwest Shelf', country: 'Australia', operator: 'Chevron' },
      { id: 'au-ichthys', name: 'Ichthys FPSO', type: 'FPSO', latitude: -11.8, longitude: 127.9, region: 'Browse Basin', country: 'Australia', operator: 'INPEX' },

      // Russia
      { id: 'ru-prirazlomnaya', name: 'Prirazlomnaya', type: 'Oil Platform', latitude: 69.25, longitude: 57.32, region: 'Pechora Sea', country: 'Russia', operator: 'Gazprom Neft', notes: 'Arctic ice-resistant platform' },
      { id: 'ru-sakhalin-1', name: 'Sakhalin-1 Platform', type: 'Oil Platform', latitude: 52.5, longitude: 143.5, region: 'Sea of Okhotsk', country: 'Russia', operator: 'Exxon/Rosneft' },
      { id: 'ru-sakhalin-2', name: 'Sakhalin-2 LUN-A', type: 'Oil Platform', latitude: 52.3, longitude: 143.2, region: 'Sea of Okhotsk', country: 'Russia', operator: 'Gazprom' },

      // Mexico
      { id: 'mx-cantarell', name: 'Cantarell Complex', type: 'Oil Platform', latitude: 19.8, longitude: -92.0, region: 'Bay of Campeche', country: 'Mexico', operator: 'Pemex' },
      { id: 'mx-ku-maloob', name: 'Ku-Maloob-Zaap', type: 'Oil Platform', latitude: 19.6, longitude: -92.3, region: 'Bay of Campeche', country: 'Mexico', operator: 'Pemex' },

      // Guyana - New major discoveries
      { id: 'gy-liza-1', name: 'Liza Destiny FPSO', type: 'FPSO', latitude: 6.6, longitude: -57.9, region: 'Stabroek Block', country: 'Guyana', operator: 'ExxonMobil' },
      { id: 'gy-liza-2', name: 'Liza Unity FPSO', type: 'FPSO', latitude: 6.5, longitude: -57.8, region: 'Stabroek Block', country: 'Guyana', operator: 'ExxonMobil' },
    ];

    // Add metadata
    const enrichedPlatforms = globalPlatforms.map(p => ({
      ...p,
      source: 'Global-Curated',
      status: 'Active',
      waterDepth: null
    }));

    this.cache.global = { data: enrichedPlatforms, timestamp: Date.now() };
    console.log(`[OFFSHORE] Loaded ${enrichedPlatforms.length} global platforms`);
    return enrichedPlatforms;
  }

  /**
   * Classify platform type based on properties
   */
  classifyPlatformType(props) {
    const name = (props.COMPLEX_NAME || props.STRUCTURE_NAME || '').toLowerCase();
    const type = (props.STRUCTURE_TYPE || props.TYPE || '').toLowerCase();

    if (type.includes('fpso') || name.includes('fpso')) return 'FPSO';
    if (type.includes('tlp') || name.includes('tlp')) return 'Tension Leg Platform';
    if (type.includes('spar')) return 'Spar Platform';
    if (type.includes('semi') || type.includes('submersible')) return 'Semi-submersible';
    if (type.includes('jack')) return 'Jack-up Rig';
    if (type.includes('drill')) return 'Drilling Platform';
    if (type.includes('gas')) return 'Gas Platform';
    return 'Oil Platform';
  }

  /**
   * Get all platforms with unified schema
   */
  async getPlatforms(options = {}) {
    try {
      const { region, country, type } = options;

      // Fetch from all sources in parallel; allSettled so one dead source still yields the other
      const _settled = await Promise.allSettled([
        this.fetchBOEMPlatforms(),
        this.fetchGlobalPlatforms()
      ]);
      const _labels = ['BOEM platforms', 'global platforms'];
      _settled.forEach((r, i) => { if (r.status === 'rejected') console.warn(`[PLATFORMS] ${_labels[i]} failed:`, r.reason?.message || r.reason); });
      const [boemPlatforms, globalPlatforms] =
        _settled.map(r => (r.status === 'fulfilled' ? r.value : []));

      // Combine all platforms
      let allPlatforms = [...boemPlatforms, ...globalPlatforms];

      // Apply filters
      if (region) {
        allPlatforms = allPlatforms.filter(p =>
          p.region?.toLowerCase().includes(region.toLowerCase()));
      }
      if (country) {
        allPlatforms = allPlatforms.filter(p =>
          p.country?.toLowerCase() === country.toLowerCase());
      }
      if (type) {
        allPlatforms = allPlatforms.filter(p =>
          p.type?.toLowerCase().includes(type.toLowerCase()));
      }

      this.platforms = allPlatforms;
      this.lastUpdate = new Date();

      // Generate summary stats
      const summary = this.generateSummary();

      return {
        timestamp: this.lastUpdate,
        count: allPlatforms.length,
        platforms: allPlatforms,
        summary
      };
    } catch (error) {
      console.error('[OFFSHORE] Error getting platforms:', error.message);
      return {
        timestamp: new Date(),
        count: this.platforms.length,
        platforms: this.platforms,
        summary: this.generateSummary(),
        error: error.message
      };
    }
  }

  /**
   * Generate summary statistics
   */
  generateSummary() {
    const byCountry = {};
    const byRegion = {};
    const byType = {};

    this.platforms.forEach(p => {
      byCountry[p.country || 'Unknown'] = (byCountry[p.country || 'Unknown'] || 0) + 1;
      byRegion[p.region || 'Unknown'] = (byRegion[p.region || 'Unknown'] || 0) + 1;
      byType[p.type || 'Unknown'] = (byType[p.type || 'Unknown'] || 0) + 1;
    });

    return { byCountry, byRegion, byType };
  }

  /**
   * Get platforms as GeoJSON for map display
   */
  toGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: this.platforms.map(p => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [p.longitude, p.latitude]
        },
        properties: {
          id: p.id,
          name: p.name,
          type: p.type,
          region: p.region,
          country: p.country,
          operator: p.operator,
          status: p.status,
          source: p.source,
          notes: p.notes || null
        }
      }))
    };
  }
}

module.exports = new OffshorePlatforms();
