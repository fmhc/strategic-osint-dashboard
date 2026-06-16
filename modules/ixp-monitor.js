const axios = require('axios');

/**
 * Internet Exchange Point (IXP) Monitor
 * Tracks global internet infrastructure - IXPs, major networks, and peering data
 *
 * Data Sources:
 * - PeeringDB (https://www.peeringdb.com/) - Free API, no auth required
 * - PCH (https://www.pch.net/) - IXP directory
 */

class IXPMonitor {
  constructor() {
    this.ixps = [];
    this.facilities = [];
    this.networks = [];
    this.lastUpdate = null;
    this.cache = {
      ixps: { data: null, timestamp: null },
      facilities: { data: null, timestamp: null }
    };
    this.CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours - IXP data rarely changes

    // Major IXPs to highlight (by PeeringDB ID or name)
    this.majorIXPs = [
      'DE-CIX Frankfurt',
      'AMS-IX',
      'LINX LON1',
      'Equinix Ashburn',
      'Equinix Chicago',
      'Equinix San Jose',
      'JPNAP Tokyo',
      'HKIX',
      'IX.br (PTT.br) São Paulo',
      'MSK-IX Moscow',
      'SIX Seattle',
      'Any2 Los Angeles',
      'ESPANIX Madrid',
      'France-IX Paris',
      'BCIX',
      'SwissIX',
      'VIX Vienna',
      'NL-ix',
      'Netnod Stockholm',
      'FICIX',
      'MIX Milan'
    ];

    // Known IXP coordinates (PeeringDB often lacks coords)
    this.knownCoordinates = {
      'DE-CIX Frankfurt': { lat: 50.1109, lon: 8.6821, city: 'Frankfurt' },
      'DE-CIX Hamburg': { lat: 53.5511, lon: 9.9937, city: 'Hamburg' },
      'DE-CIX Munich': { lat: 48.1351, lon: 11.5820, city: 'Munich' },
      'DE-CIX New York': { lat: 40.7128, lon: -74.0060, city: 'New York' },
      'DE-CIX Madrid': { lat: 40.4168, lon: -3.7038, city: 'Madrid' },
      'DE-CIX Istanbul': { lat: 41.0082, lon: 28.9784, city: 'Istanbul' },
      'DE-CIX Dubai': { lat: 25.2048, lon: 55.2708, city: 'Dubai' },
      'AMS-IX': { lat: 52.3676, lon: 4.9041, city: 'Amsterdam' },
      'LINX LON1': { lat: 51.5074, lon: -0.1278, city: 'London' },
      'LINX LON2': { lat: 51.5074, lon: -0.1278, city: 'London' },
      'France-IX Paris': { lat: 48.8566, lon: 2.3522, city: 'Paris' },
      'France-IX Marseille': { lat: 43.2965, lon: 5.3698, city: 'Marseille' },
      'IX.br (PTT.br) São Paulo': { lat: -23.5505, lon: -46.6333, city: 'São Paulo' },
      'IX.br (PTT.br) Rio de Janeiro': { lat: -22.9068, lon: -43.1729, city: 'Rio de Janeiro' },
      'Equinix Ashburn': { lat: 39.0438, lon: -77.4874, city: 'Ashburn' },
      'Equinix Chicago': { lat: 41.8781, lon: -87.6298, city: 'Chicago' },
      'Equinix San Jose': { lat: 37.3382, lon: -121.8863, city: 'San Jose' },
      'Equinix New York': { lat: 40.7128, lon: -74.0060, city: 'New York' },
      'Equinix Los Angeles': { lat: 34.0522, lon: -118.2437, city: 'Los Angeles' },
      'Equinix Dallas': { lat: 32.7767, lon: -96.7970, city: 'Dallas' },
      'Equinix Silicon Valley': { lat: 37.3861, lon: -122.0839, city: 'Silicon Valley' },
      'JPNAP Tokyo': { lat: 35.6762, lon: 139.6503, city: 'Tokyo' },
      'JPNAP Osaka': { lat: 34.6937, lon: 135.5023, city: 'Osaka' },
      'HKIX': { lat: 22.3193, lon: 114.1694, city: 'Hong Kong' },
      'SGIX': { lat: 1.3521, lon: 103.8198, city: 'Singapore' },
      'SIX Seattle': { lat: 47.6062, lon: -122.3321, city: 'Seattle' },
      'MSK-IX Moscow': { lat: 55.7558, lon: 37.6173, city: 'Moscow' },
      'ESPANIX Madrid': { lat: 40.4168, lon: -3.7038, city: 'Madrid' },
      'MIX Milan': { lat: 45.4642, lon: 9.1900, city: 'Milan' },
      'VIX Vienna': { lat: 48.2082, lon: 16.3738, city: 'Vienna' },
      'SwissIX': { lat: 47.3769, lon: 8.5417, city: 'Zurich' },
      'BCIX': { lat: 52.5200, lon: 13.4050, city: 'Berlin' },
      'Netnod Stockholm': { lat: 59.3293, lon: 18.0686, city: 'Stockholm' },
      'FICIX': { lat: 60.1699, lon: 24.9384, city: 'Helsinki' },
      'NL-ix': { lat: 52.3676, lon: 4.9041, city: 'Amsterdam' },
      'KINX': { lat: 37.5665, lon: 126.9780, city: 'Seoul' },
      'INEX': { lat: 53.3498, lon: -6.2603, city: 'Dublin' },
      'TorIX': { lat: 43.6532, lon: -79.3832, city: 'Toronto' },
      'MegaIX Sydney': { lat: -33.8688, lon: 151.2093, city: 'Sydney' },
      'MegaIX Melbourne': { lat: -37.8136, lon: 144.9631, city: 'Melbourne' },
      'Any2 Los Angeles': { lat: 34.0522, lon: -118.2437, city: 'Los Angeles' },
      'NYIIX': { lat: 40.7128, lon: -74.0060, city: 'New York' },
      'CIXP': { lat: 46.2044, lon: 6.1432, city: 'Geneva' },
      'UAE-IX': { lat: 25.2048, lon: 55.2708, city: 'Dubai' },
      'SAIX': { lat: 24.7136, lon: 46.6753, city: 'Riyadh' },
      'NAPAfrica IX Johannesburg': { lat: -26.2041, lon: 28.0473, city: 'Johannesburg' },
      'IXPN Lagos': { lat: 6.5244, lon: 3.3792, city: 'Lagos' },
      'KIXP Nairobi': { lat: -1.2921, lon: 36.8219, city: 'Nairobi' }
    };
  }

  /**
   * Fetch IXPs from PeeringDB
   */
  async fetchIXPs() {
    // Check cache
    if (this.cache.ixps.data &&
        Date.now() - this.cache.ixps.timestamp < this.CACHE_TTL) {
      return this.cache.ixps.data;
    }

    try {
      // Fetch IXPs with location data
      const response = await axios.get('https://www.peeringdb.com/api/ix', {
        timeout: 30000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'OSINT-Dashboard/1.0'
        },
        params: {
          depth: 1 // Include nested data
        }
      });

      if (response.data && response.data.data) {
        const ixps = response.data.data.map(ix => this.processIXP(ix));
        this.cache.ixps = {
          data: ixps,
          timestamp: Date.now()
        };
        console.log(`[IXP] Fetched ${ixps.length} Internet Exchange Points from PeeringDB`);
        return ixps;
      }
      return [];
    } catch (error) {
      console.error('[IXP] PeeringDB fetch error:', error.message);
      // Fallback to known major IXPs with coordinates
      if (!this.cache.ixps.data) {
        console.log('[IXP] Using fallback IXP data');
        return this.getFallbackIXPs();
      }
      return this.cache.ixps.data || [];
    }
  }

  /**
   * Get fallback IXP data from known coordinates
   */
  getFallbackIXPs() {
    const fallbackIXPs = [
      { name: 'DE-CIX Frankfurt', net_count: 1014, country: 'DE', region: 'Europe' },
      { name: 'AMS-IX', net_count: 851, country: 'NL', region: 'Europe' },
      { name: 'LINX LON1', net_count: 800, country: 'GB', region: 'Europe' },
      { name: 'IX.br (PTT.br) São Paulo', net_count: 1831, country: 'BR', region: 'South America' },
      { name: 'Equinix Ashburn', net_count: 500, country: 'US', region: 'North America' },
      { name: 'Equinix Chicago', net_count: 400, country: 'US', region: 'North America' },
      { name: 'Equinix San Jose', net_count: 350, country: 'US', region: 'North America' },
      { name: 'France-IX Paris', net_count: 450, country: 'FR', region: 'Europe' },
      { name: 'JPNAP Tokyo', net_count: 300, country: 'JP', region: 'Asia' },
      { name: 'HKIX', net_count: 280, country: 'HK', region: 'Asia' },
      { name: 'SGIX', net_count: 250, country: 'SG', region: 'Asia' },
      { name: 'MSK-IX Moscow', net_count: 600, country: 'RU', region: 'Europe' },
      { name: 'MIX Milan', net_count: 220, country: 'IT', region: 'Europe' },
      { name: 'VIX Vienna', net_count: 180, country: 'AT', region: 'Europe' },
      { name: 'Netnod Stockholm', net_count: 200, country: 'SE', region: 'Europe' },
      { name: 'BCIX', net_count: 150, country: 'DE', region: 'Europe' },
      { name: 'SwissIX', net_count: 160, country: 'CH', region: 'Europe' },
      { name: 'DE-CIX New York', net_count: 200, country: 'US', region: 'North America' },
      { name: 'SIX Seattle', net_count: 180, country: 'US', region: 'North America' },
      { name: 'Any2 Los Angeles', net_count: 160, country: 'US', region: 'North America' },
      { name: 'TorIX', net_count: 140, country: 'CA', region: 'North America' },
      { name: 'KINX', net_count: 300, country: 'KR', region: 'Asia' },
      { name: 'MegaIX Sydney', net_count: 180, country: 'AU', region: 'Oceania' },
      { name: 'NAPAfrica IX Johannesburg', net_count: 80, country: 'ZA', region: 'Africa' },
      { name: 'UAE-IX', net_count: 120, country: 'AE', region: 'Middle East' }
    ];

    return fallbackIXPs.map((ix, idx) => {
      const coords = this.knownCoordinates[ix.name];
      return {
        id: `fallback-ix-${idx}`,
        peeringDbId: null,
        name: ix.name,
        name_long: ix.name,
        city: coords?.city || ix.name.split(' ').pop(),
        country: ix.country,
        region: ix.region,
        latitude: coords?.lat || null,
        longitude: coords?.lon || null,
        website: null,
        net_count: ix.net_count,
        fac_count: 0,
        isMajor: true,
        tier: this.calculateTier({ net_count: ix.net_count }),
        source: 'Fallback'
      };
    });
  }

  /**
   * Fetch facilities (data centers) from PeeringDB
   */
  async fetchFacilities() {
    // Check cache
    if (this.cache.facilities.data &&
        Date.now() - this.cache.facilities.timestamp < this.CACHE_TTL) {
      return this.cache.facilities.data;
    }

    try {
      const response = await axios.get('https://www.peeringdb.com/api/fac', {
        timeout: 30000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'OSINT-Dashboard/1.0'
        },
        params: {
          depth: 0
        }
      });

      if (response.data && response.data.data) {
        const facilities = response.data.data
          .filter(f => f.latitude && f.longitude) // Only with coordinates
          .map(f => this.processFacility(f));

        this.cache.facilities = {
          data: facilities,
          timestamp: Date.now()
        };
        console.log(`[IXP] Fetched ${facilities.length} data center facilities`);
        return facilities;
      }
      return [];
    } catch (error) {
      console.error('[IXP] Facilities fetch error:', error.message);
      return this.cache.facilities.data || [];
    }
  }

  /**
   * Process raw IXP data into standardized format
   */
  processIXP(ix) {
    const isMajor = this.majorIXPs.some(name =>
      ix.name?.toLowerCase().includes(name.toLowerCase()) ||
      name.toLowerCase().includes(ix.name?.toLowerCase())
    );

    // Look up known coordinates
    let lat = ix.latitude;
    let lon = ix.longitude;
    const known = this.knownCoordinates[ix.name];
    if (known) {
      lat = known.lat;
      lon = known.lon;
    }

    return {
      id: `pdb-ix-${ix.id}`,
      peeringDbId: ix.id,
      name: ix.name,
      name_long: ix.name_long,
      city: ix.city,
      country: ix.country,
      region: ix.region_continent,
      latitude: lat,
      longitude: lon,
      website: ix.website,
      tech_email: ix.tech_email,
      policy_general: ix.policy_general,
      proto_unicast: ix.proto_unicast,
      proto_multicast: ix.proto_multicast,
      proto_ipv6: ix.proto_ipv6,
      net_count: ix.net_count || 0, // Number of connected networks
      fac_count: ix.fac_count || 0, // Number of facilities
      ixlan_count: ix.ixlan_count || 0,
      isMajor,
      tier: this.calculateTier(ix),
      source: 'PeeringDB',
      updated: ix.updated
    };
  }

  /**
   * Process facility data
   */
  processFacility(fac) {
    return {
      id: `pdb-fac-${fac.id}`,
      peeringDbId: fac.id,
      name: fac.name,
      city: fac.city,
      country: fac.country,
      latitude: fac.latitude,
      longitude: fac.longitude,
      address: [fac.address1, fac.address2].filter(Boolean).join(', '),
      website: fac.website,
      net_count: fac.net_count || 0,
      ix_count: fac.ix_count || 0,
      org_name: fac.org_name,
      source: 'PeeringDB'
    };
  }

  /**
   * Calculate IXP tier based on size/importance
   */
  calculateTier(ix) {
    const netCount = ix.net_count || 0;

    if (netCount >= 500) return 1; // Tier 1: Major global IXPs
    if (netCount >= 200) return 2; // Tier 2: Large regional IXPs
    if (netCount >= 50) return 3;  // Tier 3: Medium IXPs
    if (netCount >= 10) return 4;  // Tier 4: Small IXPs
    return 5; // Tier 5: Very small/new IXPs
  }

  /**
   * Get all IXP data
   */
  async getIXPs(options = {}) {
    const { minNetworks, country, tier, limit } = options;

    try {
      let ixps = await this.fetchIXPs();

      // Filter by minimum connected networks
      if (minNetworks) {
        ixps = ixps.filter(ix => ix.net_count >= minNetworks);
      }

      // Filter by country
      if (country) {
        ixps = ixps.filter(ix =>
          ix.country?.toLowerCase() === country.toLowerCase()
        );
      }

      // Filter by tier
      if (tier) {
        ixps = ixps.filter(ix => ix.tier <= tier);
      }

      // Sort by network count (largest first)
      ixps.sort((a, b) => b.net_count - a.net_count);

      // Apply limit
      if (limit) {
        ixps = ixps.slice(0, limit);
      }

      this.ixps = ixps;
      this.lastUpdate = new Date();

      // Generate summary
      const summary = this.generateSummary(ixps);

      return {
        timestamp: this.lastUpdate,
        count: ixps.length,
        ixps,
        summary
      };
    } catch (error) {
      console.error('[IXP] Error getting IXPs:', error.message);
      return {
        timestamp: new Date(),
        count: 0,
        ixps: [],
        summary: {},
        error: error.message
      };
    }
  }

  /**
   * Get facilities (data centers)
   */
  async getFacilities(options = {}) {
    const { country, minNetworks, limit } = options;

    try {
      let facilities = await this.fetchFacilities();

      if (country) {
        facilities = facilities.filter(f =>
          f.country?.toLowerCase() === country.toLowerCase()
        );
      }

      if (minNetworks) {
        facilities = facilities.filter(f => f.net_count >= minNetworks);
      }

      // Sort by network count
      facilities.sort((a, b) => b.net_count - a.net_count);

      if (limit) {
        facilities = facilities.slice(0, limit);
      }

      this.facilities = facilities;

      return {
        timestamp: new Date(),
        count: facilities.length,
        facilities
      };
    } catch (error) {
      console.error('[IXP] Error getting facilities:', error.message);
      return {
        timestamp: new Date(),
        count: 0,
        facilities: [],
        error: error.message
      };
    }
  }

  /**
   * Generate summary statistics
   */
  generateSummary(ixps) {
    const byCountry = {};
    const byRegion = {};
    const byTier = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let totalNetworks = 0;

    ixps.forEach(ix => {
      // By country
      const country = ix.country || 'Unknown';
      byCountry[country] = (byCountry[country] || 0) + 1;

      // By region
      const region = ix.region || 'Unknown';
      byRegion[region] = (byRegion[region] || 0) + 1;

      // By tier
      byTier[ix.tier] = (byTier[ix.tier] || 0) + 1;

      totalNetworks += ix.net_count || 0;
    });

    // Top countries
    const topCountries = Object.entries(byCountry)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([country, count]) => ({ country, count }));

    // Top IXPs by network count
    const topIXPs = ixps
      .slice(0, 10)
      .map(ix => ({
        name: ix.name,
        country: ix.country,
        networks: ix.net_count
      }));

    return {
      totalIXPs: ixps.length,
      totalNetworkConnections: totalNetworks,
      byTier,
      byRegion,
      topCountries,
      topIXPs
    };
  }

  /**
   * Get major IXPs only (for quick overview)
   */
  async getMajorIXPs() {
    const result = await this.getIXPs({ tier: 2 });
    return {
      ...result,
      ixps: result.ixps.filter(ix => ix.isMajor || ix.tier === 1)
    };
  }

  /**
   * Convert to GeoJSON for mapping
   */
  toGeoJSON(ixps) {
    return {
      type: 'FeatureCollection',
      features: ixps
        .filter(ix => ix.latitude && ix.longitude)
        .map(ix => ({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [ix.longitude, ix.latitude]
          },
          properties: {
            id: ix.id,
            name: ix.name,
            city: ix.city,
            country: ix.country,
            networks: ix.net_count,
            facilities: ix.fac_count,
            tier: ix.tier,
            isMajor: ix.isMajor,
            website: ix.website
          }
        }))
    };
  }

  /**
   * Get IXP statistics/health
   */
  getStatus() {
    return {
      ixpCount: this.ixps.length,
      facilityCount: this.facilities.length,
      lastUpdate: this.lastUpdate,
      cacheAge: {
        ixps: this.cache.ixps.timestamp
          ? Math.round((Date.now() - this.cache.ixps.timestamp) / 60000) + ' min'
          : 'not cached',
        facilities: this.cache.facilities.timestamp
          ? Math.round((Date.now() - this.cache.facilities.timestamp) / 60000) + ' min'
          : 'not cached'
      }
    };
  }
}

module.exports = new IXPMonitor();
