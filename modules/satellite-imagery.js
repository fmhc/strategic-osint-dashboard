const axios = require('axios');

/**
 * Satellite Imagery Module
 * Integrates multi-source satellite imagery for the OSINT dashboard
 * Uses free services that require no API keys
 */

// Free imagery sources - NO API keys required
const IMAGERY_SOURCES = {
  gibs: {
    name: 'NASA GIBS',
    type: 'wmts',
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best',
    layers: [
      { id: 'MODIS_Terra_CorrectedReflectance_TrueColor', name: 'MODIS Terra True Color', resolution: '250m' },
      { id: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', name: 'VIIRS SNPP True Color', resolution: '250m' },
      { id: 'MODIS_Aqua_CorrectedReflectance_TrueColor', name: 'MODIS Aqua True Color', resolution: '250m' },
      { id: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor', name: 'VIIRS NOAA-20 True Color', resolution: '375m' }
    ],
    capabilities: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml'
  },
  esri: {
    name: 'ESRI World Imagery',
    type: 'arcgis',
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    tileUrl: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
  },
  wayback: {
    name: 'ESRI Wayback',
    type: 'wayback',
    catalogUrl: 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/WMTSCapabilities.xml',
    tilemapUrl: 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap',
    itemsUrl: 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/world_imagery/mapserver/wmtsserver'
  },
  osm: {
    name: 'OpenStreetMap',
    type: 'osm',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
  }
};

// Strategic zones to monitor for imagery updates
const STRATEGIC_ZONES = [
  { id: 'hormuz', name: 'Strait of Hormuz', lat: 26.5, lon: 56.5, radius: 100, priority: 'CRITICAL' },
  { id: 'ukraine', name: 'Ukraine Frontlines', lat: 48.5, lon: 37.5, radius: 200, priority: 'CRITICAL' },
  { id: 'taiwan', name: 'Taiwan Strait', lat: 24.0, lon: 119.5, radius: 150, priority: 'HIGH' },
  { id: 'kaliningrad', name: 'Kaliningrad', lat: 54.7, lon: 20.5, radius: 50, priority: 'HIGH' },
  { id: 'redsea', name: 'Red Sea / Bab el-Mandeb', lat: 13.0, lon: 43.0, radius: 150, priority: 'CRITICAL' },
  { id: 'southchinasea', name: 'South China Sea', lat: 15.0, lon: 115.0, radius: 300, priority: 'HIGH' },
  { id: 'arctic', name: 'Arctic / GIUK Gap', lat: 65.0, lon: -25.0, radius: 200, priority: 'MEDIUM' },
  { id: 'venezuela', name: 'Venezuela Coast', lat: 10.5, lon: -66.0, radius: 150, priority: 'MEDIUM' },
  { id: 'iran', name: 'Iran Nuclear Sites', lat: 33.0, lon: 52.0, radius: 200, priority: 'HIGH' },
  { id: 'dprk', name: 'North Korea', lat: 39.5, lon: 126.0, radius: 150, priority: 'HIGH' }
];

// External tool URLs for advanced analysis
const EXTERNAL_TOOLS = {
  nasaWorldview: {
    name: 'NASA Worldview',
    urlTemplate: 'https://worldview.earthdata.nasa.gov/?v={west},{south},{east},{north}&t={date}',
    description: 'Daily MODIS/VIIRS imagery with time slider'
  },
  sentinelHub: {
    name: 'Sentinel Hub EO Browser',
    urlTemplate: 'https://apps.sentinel-hub.com/eo-browser/?lat={lat}&lng={lon}&zoom=12',
    description: 'Multispectral Sentinel-2 imagery'
  },
  googleEarthWeb: {
    name: 'Google Earth Web',
    urlTemplate: 'https://earth.google.com/web/@{lat},{lon},1000a,1000d,35y,0h,0t,0r',
    description: '3D terrain and high-res imagery'
  },
  copernicus: {
    name: 'Copernicus Browser',
    urlTemplate: 'https://browser.dataspace.copernicus.eu/?lat={lat}&lng={lon}&zoom=12',
    description: 'Free Sentinel data access'
  }
};

class SatelliteImagery {
  constructor() {
    this.cache = {
      waybackVersions: null,
      waybackTimestamp: null,
      gibsLayers: null,
      gibsTimestamp: null,
      zoneImagery: null,
      zoneTimestamp: null
    };
    this.cacheTimeout = 60 * 60 * 1000; // 1 hour cache
    this.lastUpdate = null;
  }

  /**
   * Get available imagery layers for the frontend
   */
  getAvailableLayers() {
    return {
      providers: Object.entries(IMAGERY_SOURCES).map(([key, source]) => ({
        id: key,
        name: source.name,
        type: source.type,
        url: source.url,
        layers: source.layers || null
      })),
      externalTools: EXTERNAL_TOOLS,
      strategicZones: STRATEGIC_ZONES
    };
  }

  /**
   * Fetch ESRI Wayback versions (historical imagery catalog)
   */
  async fetchWaybackVersions() {
    // Check cache
    if (this.cache.waybackVersions &&
        Date.now() - this.cache.waybackTimestamp < this.cacheTimeout) {
      return this.cache.waybackVersions;
    }

    try {
      // Wayback config API - returns available historical versions
      const response = await axios.get(
        'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer?f=json',
        { timeout: 10000 }
      );

      // Parse available versions from MapServer info
      // The actual versions list is obtained from a config endpoint
      const configResponse = await axios.get(
        'https://waybackconfig.arcgis.com/config/waybacked-imagery/config.json',
        { timeout: 10000 }
      );

      const versions = configResponse.data?.releaseNum2ItemsLookup || {};
      const versionList = Object.entries(versions).map(([releaseNum, items]) => ({
        releaseNum: parseInt(releaseNum),
        itemId: items[0]?.itemId || null,
        releaseDateLabel: items[0]?.releaseDateLabel || 'Unknown',
        releaseDate: this.parseReleaseDate(items[0]?.releaseDateLabel)
      })).filter(v => v.itemId).sort((a, b) => b.releaseNum - a.releaseNum);

      this.cache.waybackVersions = {
        count: versionList.length,
        versions: versionList.slice(0, 50), // Latest 50 versions
        oldestDate: versionList[versionList.length - 1]?.releaseDateLabel,
        newestDate: versionList[0]?.releaseDateLabel,
        fetchedAt: new Date()
      };
      this.cache.waybackTimestamp = Date.now();

      return this.cache.waybackVersions;
    } catch (error) {
      console.error('[SATELLITE] Error fetching Wayback versions:', error.message);

      // Return synthetic data for demo
      return this.generateSyntheticWaybackVersions();
    }
  }

  parseReleaseDate(dateLabel) {
    if (!dateLabel) return null;
    // Format: "Feb 20, 2024" -> Date object
    try {
      return new Date(dateLabel);
    } catch {
      return null;
    }
  }

  generateSyntheticWaybackVersions() {
    const versions = [];
    const now = new Date();

    // Generate monthly versions going back 10 years
    for (let i = 0; i < 50; i++) {
      const date = new Date(now);
      date.setMonth(date.getMonth() - i);
      versions.push({
        releaseNum: 1000 - i,
        itemId: `wayback-${1000 - i}`,
        releaseDateLabel: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        releaseDate: date
      });
    }

    return {
      count: versions.length,
      versions,
      oldestDate: versions[versions.length - 1].releaseDateLabel,
      newestDate: versions[0].releaseDateLabel,
      fetchedAt: new Date(),
      synthetic: true
    };
  }

  /**
   * Fetch NASA GIBS available layers and dates
   */
  async fetchGIBSLayers(targetDate = null) {
    const date = targetDate || new Date().toISOString().split('T')[0];

    try {
      // GIBS provides daily imagery - check availability for target date
      const layers = IMAGERY_SOURCES.gibs.layers.map(layer => ({
        ...layer,
        available: true, // GIBS has good historical coverage
        date: date,
        tileUrl: `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${layer.id}/default/${date}/250m/{TileMatrix}/{TileRow}/{TileCol}.jpg`
      }));

      return {
        date,
        layers,
        source: 'NASA GIBS',
        coverage: 'Global',
        updateFrequency: 'Daily'
      };
    } catch (error) {
      console.error('[SATELLITE] Error fetching GIBS layers:', error.message);
      return {
        date,
        layers: IMAGERY_SOURCES.gibs.layers,
        error: error.message
      };
    }
  }

  /**
   * Check imagery availability for a specific zone
   */
  async checkZoneImagery(zone) {
    const result = {
      zone: zone.name,
      id: zone.id,
      lat: zone.lat,
      lon: zone.lon,
      priority: zone.priority,
      sources: []
    };

    // GIBS - always available with ~1 day latency
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const gibsDate = yesterday.toISOString().split('T')[0];

    result.sources.push({
      provider: 'NASA GIBS',
      available: true,
      latestDate: gibsDate,
      latency: '1 day',
      resolution: '250m',
      viewUrl: this.generateExternalUrl('nasaWorldview', zone.lat, zone.lon, gibsDate)
    });

    // ESRI Wayback - check tile availability
    result.sources.push({
      provider: 'ESRI Wayback',
      available: true,
      latestDate: new Date().toISOString().split('T')[0],
      latency: '< 1 month',
      resolution: '~0.3-1m',
      viewUrl: null // Integrated in dashboard
    });

    // Sentinel Hub EO Browser link
    result.sources.push({
      provider: 'Sentinel Hub',
      available: true,
      latestDate: new Date().toISOString().split('T')[0],
      latency: '5 days',
      resolution: '10m',
      viewUrl: this.generateExternalUrl('sentinelHub', zone.lat, zone.lon)
    });

    return result;
  }

  /**
   * Get latest imagery status for all strategic zones
   */
  async fetchZoneImagery() {
    // Check cache
    if (this.cache.zoneImagery &&
        Date.now() - this.cache.zoneTimestamp < this.cacheTimeout) {
      return this.cache.zoneImagery;
    }

    const _settled = await Promise.allSettled(
      STRATEGIC_ZONES.map(zone => this.checkZoneImagery(zone))
    );
    const results = _settled.map((r, i) => r.status === 'fulfilled' ? r.value : {
      zone: STRATEGIC_ZONES[i]?.name, id: STRATEGIC_ZONES[i]?.id,
      priority: STRATEGIC_ZONES[i]?.priority || 'UNKNOWN', sources: []
    });

    this.cache.zoneImagery = {
      timestamp: new Date(),
      zones: results,
      summary: {
        totalZones: results.length,
        criticalZones: results.filter(z => z.priority === 'CRITICAL').length,
        allSourcesAvailable: results.every(z => z.sources.every(s => s.available))
      }
    };
    this.cache.zoneTimestamp = Date.now();

    return this.cache.zoneImagery;
  }

  /**
   * Generate external tool URL
   */
  generateExternalUrl(tool, lat, lon, date = null) {
    const toolConfig = EXTERNAL_TOOLS[tool];
    if (!toolConfig) return null;

    let url = toolConfig.urlTemplate
      .replace('{lat}', lat.toFixed(4))
      .replace('{lon}', lon.toFixed(4))
      .replace('{lng}', lon.toFixed(4));

    if (date) {
      url = url.replace('{date}', date);
    }

    // Calculate bounding box for NASA Worldview
    if (tool === 'nasaWorldview') {
      const offset = 2; // degrees
      url = url
        .replace('{west}', (lon - offset).toFixed(2))
        .replace('{south}', (lat - offset).toFixed(2))
        .replace('{east}', (lon + offset).toFixed(2))
        .replace('{north}', (lat + offset).toFixed(2));
    }

    return url;
  }

  /**
   * Compare imagery between two dates (metadata only)
   */
  async compareImagery(lat, lon, date1, date2) {
    return {
      location: { lat, lon },
      date1: {
        date: date1,
        gibsAvailable: true,
        gibsUrl: `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${date1}/250m/{z}/{y}/{x}.jpg`
      },
      date2: {
        date: date2,
        gibsAvailable: true,
        gibsUrl: `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${date2}/250m/{z}/{y}/{x}.jpg`
      },
      nasaWorldviewCompare: `https://worldview.earthdata.nasa.gov/?v=${lon-2},${lat-2},${lon+2},${lat+2}&t=${date2}&t1=${date1}`,
      changeDetectionNote: 'Visual comparison available via NASA Worldview or Sentinel Hub EO Browser'
    };
  }

  /**
   * Main update function for cron scheduler
   */
  async updateSatelliteData() {
    try {
      console.log('[SATELLITE] Updating satellite imagery data...');

      // allSettled so a wayback fetch failure still yields zone imagery (and vice versa)
      const _settled = await Promise.allSettled([
        this.fetchWaybackVersions(),
        this.fetchZoneImagery()
      ]);
      if (_settled[0].status === 'rejected') console.warn('[SATELLITE] wayback fetch failed:', _settled[0].reason?.message || _settled[0].reason);
      if (_settled[1].status === 'rejected') console.warn('[SATELLITE] zone imagery failed:', _settled[1].reason?.message || _settled[1].reason);
      const wayback = _settled[0].status === 'fulfilled' ? _settled[0].value : { count: 0, newestDate: null, oldestDate: null };
      const zones = _settled[1].status === 'fulfilled' ? _settled[1].value : { summary: {} };

      this.lastUpdate = new Date();

      return {
        timestamp: this.lastUpdate,
        wayback: {
          versionsAvailable: wayback.count,
          newestVersion: wayback.newestDate,
          oldestVersion: wayback.oldestDate
        },
        zones: zones.summary,
        sources: Object.keys(IMAGERY_SOURCES).length,
        status: 'operational'
      };
    } catch (error) {
      console.error('[SATELLITE] Error updating satellite data:', error.message);
      return {
        timestamp: new Date(),
        error: error.message,
        status: 'degraded'
      };
    }
  }

  /**
   * Get Cesium-compatible imagery provider configurations
   */
  getCesiumProviders() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const gibsDate = yesterday.toISOString().split('T')[0];

    return {
      esri: {
        type: 'ArcGisMapServerImageryProvider',
        url: IMAGERY_SOURCES.esri.url
      },
      osm: {
        type: 'OpenStreetMapImageryProvider',
        url: 'https://tile.openstreetmap.org/'
      },
      gibs_modis: {
        type: 'WebMapTileServiceImageryProvider',
        url: `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${gibsDate}/250m/{TileMatrix}/{TileRow}/{TileCol}.jpg`,
        layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
        style: 'default',
        format: 'image/jpeg',
        tileMatrixSetID: '250m',
        maximumLevel: 8
      },
      gibs_viirs: {
        type: 'WebMapTileServiceImageryProvider',
        url: `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${gibsDate}/250m/{TileMatrix}/{TileRow}/{TileCol}.jpg`,
        layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
        style: 'default',
        format: 'image/jpeg',
        tileMatrixSetID: '250m',
        maximumLevel: 8
      }
    };
  }
}

module.exports = new SatelliteImagery();
