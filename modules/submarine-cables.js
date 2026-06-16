const axios = require('axios');

/**
 * Submarine Cables Module
 * Tracks global undersea telecommunications cables and landing stations
 *
 * Data Source: TeleGeography Submarine Cable Map (CC BY-NC-SA 3.0)
 * https://www.submarinecablemap.com/
 */

class SubmarineCables {
  constructor() {
    this.cables = [];
    this.landingPoints = [];
    this.lastUpdate = null;
    this.cache = {
      cables: { data: null, timestamp: null },
      landingPoints: { data: null, timestamp: null }
    };
    this.CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours - cables rarely change
  }

  /**
   * Simplify line geometry by keeping every Nth point
   * Reduces data size significantly while maintaining cable shape
   */
  simplifyCoordinates(coords, keepEvery = 5) {
    if (!coords || coords.length <= 2) return coords;
    const simplified = [coords[0]]; // Keep first point
    for (let i = keepEvery; i < coords.length - 1; i += keepEvery) {
      simplified.push(coords[i]);
    }
    simplified.push(coords[coords.length - 1]); // Keep last point
    return simplified;
  }

  /**
   * Simplify cable geometry to reduce payload size
   */
  simplifyCableGeometry(feature, keepEvery = 5) {
    if (!feature.geometry) return feature;

    const geometry = { ...feature.geometry };

    if (geometry.type === 'LineString') {
      geometry.coordinates = this.simplifyCoordinates(geometry.coordinates, keepEvery);
    } else if (geometry.type === 'MultiLineString') {
      geometry.coordinates = geometry.coordinates.map(line =>
        this.simplifyCoordinates(line, keepEvery)
      );
    }

    return { ...feature, geometry };
  }

  /**
   * Fetch cable routes from TeleGeography API
   */
  async fetchCables() {
    // Check cache
    if (this.cache.cables.data &&
        Date.now() - this.cache.cables.timestamp < this.CACHE_TTL) {
      return this.cache.cables.data;
    }

    try {
      const response = await axios.get(
        'https://www.submarinecablemap.com/api/v3/cable/cable-geo.json',
        { timeout: 30000 }
      );

      if (response.data && response.data.features) {
        this.cache.cables = {
          data: response.data,
          timestamp: Date.now()
        };
        console.log(`[CABLES] Fetched ${response.data.features.length} submarine cables`);
        return response.data;
      }
      return { type: 'FeatureCollection', features: [] };
    } catch (error) {
      console.error('[CABLES] Cable fetch error:', error.message);
      return this.cache.cables.data || { type: 'FeatureCollection', features: [] };
    }
  }

  /**
   * Fetch cable metadata (owners, length, RFS date)
   */
  async fetchCableMetadata() {
    try {
      const response = await axios.get(
        'https://www.submarinecablemap.com/api/v3/cable/all.json',
        { timeout: 30000 }
      );
      return response.data || [];
    } catch (error) {
      console.error('[CABLES] Metadata fetch error:', error.message);
      return [];
    }
  }

  /**
   * Fetch landing points from TeleGeography API
   */
  async fetchLandingPoints() {
    // Check cache
    if (this.cache.landingPoints.data &&
        Date.now() - this.cache.landingPoints.timestamp < this.CACHE_TTL) {
      return this.cache.landingPoints.data;
    }

    try {
      const response = await axios.get(
        'https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json',
        { timeout: 30000 }
      );

      if (response.data && response.data.features) {
        this.cache.landingPoints = {
          data: response.data,
          timestamp: Date.now()
        };
        console.log(`[CABLES] Fetched ${response.data.features.length} landing points`);
        return response.data;
      }
      return { type: 'FeatureCollection', features: [] };
    } catch (error) {
      console.error('[CABLES] Landing points fetch error:', error.message);
      return this.cache.landingPoints.data || { type: 'FeatureCollection', features: [] };
    }
  }

  /**
   * Get all submarine cable data
   * @param {Object} options - Options object
   * @param {boolean} options.fullResolution - If true, return full geometry without simplification
   */
  async getCables(options = {}) {
    const { fullResolution = false } = options;
    try {
      // allSettled so a single failing source degrades gracefully (empty) instead of throwing
      const _settled = await Promise.allSettled([
        this.fetchCables(),
        this.fetchLandingPoints(),
        this.fetchCableMetadata()
      ]);
      const _labels = ['cables', 'landing points', 'cable metadata'];
      _settled.forEach((r, i) => { if (r.status === 'rejected') console.warn(`[CABLES] ${_labels[i]} failed:`, r.reason?.message || r.reason); });
      const cablesGeo = _settled[0].status === 'fulfilled' ? _settled[0].value : { type: 'FeatureCollection', features: [] };
      const landingPointsGeo = _settled[1].status === 'fulfilled' ? _settled[1].value : { type: 'FeatureCollection', features: [] };
      const metadata = _settled[2].status === 'fulfilled' ? _settled[2].value : [];

      // Create metadata lookup
      const metadataMap = new Map();
      if (Array.isArray(metadata)) {
        metadata.forEach(cable => {
          metadataMap.set(cable.id, cable);
        });
      }

      // Enrich cable features with metadata and optionally simplify geometry
      const enrichedCables = cablesGeo.features?.map(feature => {
        const meta = metadataMap.get(feature.properties?.id) || {};
        const enriched = {
          ...feature,
          properties: {
            ...feature.properties,
            name: meta.name || feature.properties?.name || 'Unknown Cable',
            length_km: meta.length ? parseFloat(meta.length.replace(/,/g, '')) : null,
            rfs: meta.rfs || null, // Ready for Service date
            owners: meta.owners || [],
            url: meta.url || null,
            is_planned: meta.is_planned || false,
            notes: meta.notes || null,
            landing_points: meta.landing_points || []
          }
        };
        // Simplify geometry unless full resolution requested
        if (fullResolution) {
          return enriched;
        }
        // Simplify geometry - keep every 5th point (reduces size ~80%)
        return this.simplifyCableGeometry(enriched, 5);
      }) || [];

      // Process landing points
      const landingPoints = landingPointsGeo.features?.map(feature => ({
        id: feature.properties?.id,
        name: feature.properties?.name || 'Unknown Landing Point',
        country: feature.properties?.country || null,
        latitude: feature.geometry?.coordinates?.[1],
        longitude: feature.geometry?.coordinates?.[0],
        cableCount: feature.properties?.cable_count || 0
      })) || [];

      this.cables = enrichedCables;
      this.landingPoints = landingPoints;
      this.lastUpdate = new Date();

      // Generate summary
      const summary = this.generateSummary(enrichedCables, landingPoints);

      return {
        timestamp: this.lastUpdate,
        cableCount: enrichedCables.length,
        landingPointCount: landingPoints.length,
        cables: {
          type: 'FeatureCollection',
          features: enrichedCables
        },
        landingPoints: {
          type: 'FeatureCollection',
          features: landingPointsGeo.features || []
        },
        summary
      };
    } catch (error) {
      console.error('[CABLES] Error getting cables:', error.message);
      return {
        timestamp: new Date(),
        cableCount: 0,
        landingPointCount: 0,
        cables: { type: 'FeatureCollection', features: [] },
        landingPoints: { type: 'FeatureCollection', features: [] },
        summary: {},
        error: error.message
      };
    }
  }

  /**
   * Generate summary statistics
   */
  generateSummary(cables, landingPoints) {
    const activeCables = cables.filter(c => !c.properties?.is_planned);
    const plannedCables = cables.filter(c => c.properties?.is_planned);

    // Count by approximate region based on coordinates
    const byRegion = {
      'Atlantic': 0,
      'Pacific': 0,
      'Indian Ocean': 0,
      'Mediterranean': 0,
      'Other': 0
    };

    cables.forEach(cable => {
      const coords = cable.geometry?.coordinates;
      if (coords && coords.length > 0) {
        // Get midpoint of cable for rough classification
        const mid = coords[Math.floor(coords.length / 2)];
        if (Array.isArray(mid)) {
          const lon = mid[0];
          const lat = mid[1];

          if (lon > -80 && lon < 20 && lat > -60 && lat < 70) {
            byRegion['Atlantic']++;
          } else if (lon > 20 && lon < 120 && lat > -40 && lat < 40) {
            byRegion['Indian Ocean']++;
          } else if ((lon > 100 || lon < -60) && lat > -60 && lat < 70) {
            byRegion['Pacific']++;
          } else if (lon > -10 && lon < 40 && lat > 30 && lat < 47) {
            byRegion['Mediterranean']++;
          } else {
            byRegion['Other']++;
          }
        }
      }
    });

    // Top countries by landing points
    const countryCount = {};
    landingPoints.forEach(lp => {
      if (lp.country) {
        countryCount[lp.country] = (countryCount[lp.country] || 0) + 1;
      }
    });

    const topCountries = Object.entries(countryCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([country, count]) => ({ country, count }));

    return {
      totalCables: cables.length,
      activeCables: activeCables.length,
      plannedCables: plannedCables.length,
      totalLandingPoints: landingPoints.length,
      byRegion,
      topCountries
    };
  }

  /**
   * Get critical cables (high-traffic routes)
   */
  getCriticalCables() {
    // List of strategically important cables
    const criticalCableNames = [
      'SEA-ME-WE', // Southeast Asia - Middle East - Western Europe
      'FLAG', // Fiber-Optic Link Around the Globe
      'TAT-14', // Transatlantic
      'Apollo', // Transatlantic
      'MAREA', // Microsoft/Facebook transatlantic
      'Dunant', // Google transatlantic
      'Grace Hopper', // Google transatlantic
      'Pacific Light', // Trans-Pacific
      'FASTER', // Trans-Pacific
      'Unity', // Trans-Pacific
      'AAE-1', // Asia-Africa-Europe
      'EIG', // Europe India Gateway
      '2Africa', // Meta's Africa cable
    ];

    return this.cables.filter(cable => {
      const name = cable.properties?.name || '';
      return criticalCableNames.some(critical =>
        name.toLowerCase().includes(critical.toLowerCase())
      );
    });
  }

  /**
   * Search cables by name or owner
   */
  searchCables(query) {
    const q = query.toLowerCase();
    return this.cables.filter(cable => {
      const name = (cable.properties?.name || '').toLowerCase();
      const owners = (cable.properties?.owners || []).join(' ').toLowerCase();
      return name.includes(q) || owners.includes(q);
    });
  }
}

module.exports = new SubmarineCables();
