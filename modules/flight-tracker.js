const axios = require('axios');

/**
 * Flight Tracker Module - Enhanced with FREE APIs
 * 
 * Data Sources (ALL FREE):
 * - OpenSky Network API (free, rate-limited)
 * - ADS-B Exchange Public API (free, limited)
 * - FlightRadar24 Public Data (scraping)
 */

// Strategic aircraft types to monitor
const STRATEGIC_AIRCRAFT = {
  tankers: ['KC135', 'KC46', 'KC10', 'KC-135', 'KC-46', 'KC-10', 'LAGR', 'NCHO'],
  bombers: ['B2', 'B52', 'B1', 'B-2', 'B-52', 'B-1', 'B21', 'B-21', 'DOOM', 'DEATH'],
  specialOps: ['C17', 'C-17', 'C130', 'C-130', 'MH60', 'MH-60', 'MH47', 'MH-47', 'MC130'],
  surveillance: ['P8', 'P-8', 'RC135', 'RC-135', 'E8', 'E-8', 'AWACS', 'E3', 'E-3', 'RIVET'],
  electronicWarfare: ['EA18', 'EA-18', 'EC130', 'EC-130', 'Growler', 'PROWL']
};

// Military callsign prefixes
const MILITARY_CALLSIGNS = [
  'MYTEE',   // B-2 Spirit
  'DARK',    // Stealth ops
  'DEATH',   // B-52
  'DOOM',    // B-1B
  'NIGHT',   // 160th SOAR Night Stalkers
  'RCH',     // Reach - Air Mobility Command
  'EVAC',    // Medical Evacuation
  'SPAR',    // VIP Transport
  'SAM',     // Special Air Mission
  'IRON',    // F-117/Stealth
  'STEEL',   // Fighter ops
  'VIPER',   // F-16
  'RAPTOR',  // F-22
  'LIGHTNING', // F-35
  'BONE',    // B-1B
  'BUFF',    // B-52
  'COBRA',   // AH-1
  'APACHE',  // AH-64
  'HAWK',    // E-2
  'MAGIC',   // AWACS
  'DRAGN',   // U-2
  'SENIOR',  // RC-135
  'RIVET',   // RC-135
  'LANCER',  // B-1B
  'SPIRIT',  // B-2
  'RAIDER',  // B-21
  'FORCE',   // Air Force
  'NAVY',
  'ARMY',
  'USAF',
  'JAKE',    // Navy/Marines
  'TOPGUN',
  'REAPER',  // MQ-9
  'PREDATOR', // MQ-1
  'GLOBAL',  // RQ-4 Global Hawk
  'FORTE',   // RQ-4
  'RAIDR',   // Various
  'THUD',    // Various
  'WEASEL',  // SEAD missions
  'TALON',   // Special ops
  'SPECTRE', // AC-130
  'SPOOKY',  // AC-130
  'GUNSHIP'  // AC-130
];

// Strategic regions of interest
const REGIONS = {
  persianGulf: { name: 'Persian Gulf', lat: 27, lon: 52, radius: 1000, priority: 'CRITICAL' },
  northAtlantic: { name: 'North Atlantic', lat: 62, lon: -25, radius: 1500, priority: 'HIGH' },
  caribbean: { name: 'Caribbean', lat: 15, lon: -70, radius: 800, priority: 'HIGH' },
  arctic: { name: 'Arctic', lat: 75, lon: -40, radius: 1200, priority: 'HIGH' },
  mediterranean: { name: 'Mediterranean', lat: 35, lon: 18, radius: 1000, priority: 'MEDIUM' },
  southChinaSea: { name: 'South China Sea', lat: 15, lon: 115, radius: 800, priority: 'MEDIUM' },
  blackSea: { name: 'Black Sea', lat: 43, lon: 34, radius: 500, priority: 'HIGH' },
  balticSea: { name: 'Baltic Sea', lat: 56, lon: 18, radius: 400, priority: 'MEDIUM' }
};

class FlightTracker {
  constructor() {
    this.lastUpdate = null;
    this.trackedFlights = [];
    this.cache = new Map();
    this.cacheTimeout = 60000; // 1 minute cache
    this.openSkyCooldownUntil = 0; // backoff timestamp after rate-limit
    this.adsbCooldownUntil = 0;    // ADS-B Exchange blocks bots (403) → long skip
  }

  async getStrategicFlights() {
    try {
      // Fetch from multiple FREE sources in parallel
      const [openSkyData, adsbData] = await Promise.allSettled([
        this.fetchOpenSkyNetwork(),
        this.fetchADSBExchangePublic()
      ]);
      
      // Combine results
      let allFlights = [];
      
      if (openSkyData.status === 'fulfilled') {
        allFlights = [...allFlights, ...openSkyData.value];
      }
      
      if (adsbData.status === 'fulfilled') {
        allFlights = [...allFlights, ...adsbData.value];
      }
      
      // Deduplicate by ICAO24
      const uniqueFlights = this.deduplicateFlights(allFlights);
      
      // If limited real data, supplement with synthetic for demonstration
      // Always add synthetic when real data count is low
      if (uniqueFlights.length < 10) {
        const synthetic = this.generateMinimalSynthetic();
        // Add synthetic flights that don't conflict with real ICAO24s
        const existingIds = new Set(uniqueFlights.map(f => f.icao24));
        synthetic.forEach(s => {
          if (!existingIds.has(s.icao24)) {
            uniqueFlights.push(s);
          }
        });
      }
      
      this.trackedFlights = uniqueFlights;
      this.lastUpdate = new Date();
      
      return {
        timestamp: this.lastUpdate,
        count: this.trackedFlights.length,
        flights: this.trackedFlights,
        summary: this.generateSummary(),
        sources: {
          opensky: openSkyData.status === 'fulfilled' ? openSkyData.value.length : 0,
          adsb: adsbData.status === 'fulfilled' ? adsbData.value.length : 0
        }
      };
    } catch (error) {
      console.error('[FLIGHT] Error fetching flight data:', error.message);
      return {
        timestamp: new Date(),
        count: this.trackedFlights.length,
        flights: this.trackedFlights,
        summary: this.generateSummary(),
        error: error.message
      };
    }
  }

  async fetchOpenSkyNetwork() {
    try {
      // Check cache first
      const cached = this.cache.get('opensky');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // Backoff: if we were rate-limited recently, serve stale cache instead of hammering
      if (this.openSkyCooldownUntil && Date.now() < this.openSkyCooldownUntil) {
        return cached?.data || [];
      }

      // OpenSky Network API — free tier ~400 calls/day unauthenticated; Basic auth
      // (OPENSKY_USER/OPENSKY_PASS) raises the quota substantially.
      const reqOpts = {
        timeout: 15000,
        headers: { 'User-Agent': 'OSINT-Dashboard/1.0' }
      };
      if (process.env.OPENSKY_USER && process.env.OPENSKY_PASS) {
        reqOpts.auth = { username: process.env.OPENSKY_USER, password: process.env.OPENSKY_PASS };
      }
      const response = await axios.get('https://opensky-network.org/api/states/all', reqOpts);

      if (!response.data || !response.data.states) {
        return [];
      }

      const strategicFlights = response.data.states
        .filter(state => this.isStrategicAircraft(state))
        .map(state => this.parseOpenSkyState(state, 'opensky'));

      // Cache results
      this.cache.set('opensky', { data: strategicFlights, time: Date.now() });
      this.openSkyCooldownUntil = 0; // success clears any backoff

      console.log(`[FLIGHT] OpenSky: Found ${strategicFlights.length} strategic aircraft`);
      return strategicFlights;
    } catch (error) {
      const status = error.response?.status;
      if (status === 429 || status === 503 || (status >= 500)) {
        // Rate-limited / upstream error → back off 10min and serve last-known data
        this.openSkyCooldownUntil = Date.now() + 10 * 60 * 1000;
        console.warn(`[FLIGHT] OpenSky ${status} — backing off 10min, serving cached data`);
      } else {
        console.error('[FLIGHT] OpenSky API error:', error.message);
      }
      const cached = this.cache.get('opensky');
      return cached?.data || [];
    }
  }

  async fetchADSBExchangePublic() {
    try {
      // Check cache
      const cached = this.cache.get('adsb');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // Graceful skip: ADS-B Exchange blocks automated requests (403). After a
      // block we stop hitting it for a long cooldown and rely on OpenSky instead.
      if (this.adsbCooldownUntil && Date.now() < this.adsbCooldownUntil) {
        return cached?.data || [];
      }

      // ADS-B Exchange Public API - FREE (limited data)
      // Military aircraft endpoint
      const response = await axios.get('https://globe.adsbexchange.com/data/mil.json', {
        timeout: 15000,
        headers: {
          'User-Agent': 'OSINT-Dashboard/1.0',
          'Accept': 'application/json'
        }
      });
      
      if (!response.data || !response.data.ac) {
        return [];
      }

      const flights = response.data.ac
        .filter(ac => this.isInterestingADSB(ac))
        .map(ac => this.parseADSBData(ac, 'adsb-exchange'));

      this.cache.set('adsb', { data: flights, time: Date.now() });
      
      console.log(`[FLIGHT] ADS-B Exchange: Found ${flights.length} military aircraft`);
      return flights;
    } catch (error) {
      const status = error.response?.status;
      const cached = this.cache.get('adsb');
      if (status === 403 || status === 401 || status === 429) {
        // Blocked/limited → skip for 6h, rely on OpenSky (avoids per-poll log spam)
        this.adsbCooldownUntil = Date.now() + 6 * 60 * 60 * 1000;
        console.warn(`[FLIGHT] ADS-B Exchange ${status} (blocks bots) — skipping for 6h, using OpenSky`);
      } else {
        console.error('[FLIGHT] ADS-B Exchange error:', error.message);
      }
      return cached?.data || [];
    }
  }

  isStrategicAircraft(state) {
    const callsign = (state[1] || '').trim().toUpperCase();
    const icao24 = (state[0] || '').toUpperCase();
    
    // Check military callsign prefixes
    for (const prefix of MILITARY_CALLSIGNS) {
      if (callsign.startsWith(prefix)) {
        return true;
      }
    }
    
    // Check for NATO/US military ICAO ranges
    // US Military: AE0000-AE6FFF, 340000-3BFFFF
    if (icao24.match(/^AE[0-6][0-9A-F]{3}$/) || 
        icao24.match(/^3[4-9A-B][0-9A-F]{4}$/)) {
      return true;
    }
    
    return false;
  }

  isInterestingADSB(ac) {
    const flight = (ac.flight || ac.r || '').trim().toUpperCase();
    const type = (ac.t || '').toUpperCase();
    
    // Check callsign
    for (const prefix of MILITARY_CALLSIGNS) {
      if (flight.startsWith(prefix)) {
        return true;
      }
    }
    
    // Check aircraft type codes
    const militaryTypes = ['B52', 'B1', 'B2', 'C17', 'C130', 'KC135', 'KC10', 'KC46', 
                          'E3', 'E8', 'RC135', 'P8', 'MQ9', 'RQ4', 'F22', 'F35', 'F16',
                          'F15', 'F18', 'A10', 'AC130', 'MC130', 'HC130'];
    if (militaryTypes.some(t => type.includes(t))) {
      return true;
    }
    
    return false;
  }

  parseOpenSkyState(state, source) {
    const callsign = (state[1] || '').trim();
    const category = this.categorizeAircraft(callsign);
    
    return {
      icao24: state[0],
      callsign: callsign,
      origin: state[2] || 'Unknown',
      timestamp: state[3],
      lastContact: state[4],
      longitude: state[5],
      latitude: state[6],
      altitude: state[7] ? Math.round(state[7] * 3.28084) : null, // Convert to feet
      onGround: state[8],
      velocity: state[9] ? Math.round(state[9] * 1.94384) : null, // Convert to knots
      heading: state[10],
      verticalRate: state[11] ? Math.round(state[11] * 196.85) : null, // Convert to ft/min
      category: category,
      threatLevel: this.assessThreatLevel(callsign, state[7], state[9]),
      source: source,
      region: this.determineRegion(state[6], state[5])
    };
  }

  parseADSBData(ac, source) {
    const callsign = (ac.flight || ac.r || '').trim();
    
    return {
      icao24: ac.hex || ac.icao,
      callsign: callsign,
      origin: ac.ownOp || 'Unknown',
      timestamp: Date.now() / 1000,
      lastContact: ac.seen ? (Date.now() / 1000 - ac.seen) : null,
      longitude: ac.lon,
      latitude: ac.lat,
      altitude: ac.alt_baro || ac.alt_geom,
      onGround: ac.ground || false,
      velocity: ac.gs, // Already in knots
      heading: ac.track || ac.true_heading,
      verticalRate: ac.baro_rate,
      category: this.categorizeAircraft(callsign),
      threatLevel: this.assessThreatLevel(callsign, ac.alt_baro, ac.gs),
      aircraftType: ac.t,
      source: source,
      region: this.determineRegion(ac.lat, ac.lon),
      squawk: ac.squawk
    };
  }

  categorizeAircraft(callsign) {
    const cs = (callsign || '').toUpperCase();
    
    // Check strategic aircraft categories
    for (const [category, keywords] of Object.entries(STRATEGIC_AIRCRAFT)) {
      if (keywords.some(kw => cs.includes(kw))) {
        return category;
      }
    }
    
    // Check specific callsigns
    if (cs.startsWith('MYTEE') || cs.includes('SPIRIT')) return 'stealth-bomber';
    if (cs.startsWith('DEATH') || cs.includes('BUFF')) return 'bombers';
    if (cs.startsWith('DOOM') || cs.startsWith('BONE') || cs.includes('LANCER')) return 'bombers';
    if (cs.startsWith('NIGHT') || cs.startsWith('TALON')) return 'special-ops';
    if (cs.startsWith('RCH') || cs.startsWith('EVAC')) return 'transport';
    if (cs.startsWith('FORTE') || cs.startsWith('GLOBAL')) return 'surveillance';
    if (cs.startsWith('REAPER') || cs.startsWith('PREDATOR')) return 'uav';
    
    return 'military-unknown';
  }

  assessThreatLevel(callsign, altitude, velocity) {
    const cs = (callsign || '').toUpperCase();
    
    // CRITICAL - Stealth bombers
    if (cs.startsWith('MYTEE') || cs.includes('SPIRIT') || cs.includes('RAIDER')) {
      return 'CRITICAL';
    }
    
    // HIGH - Strategic bombers in flight
    if (cs.startsWith('DEATH') || cs.startsWith('DOOM') || cs.startsWith('BONE')) {
      return 'HIGH';
    }
    
    // HIGH - Special operations
    if (cs.startsWith('NIGHT') || cs.startsWith('TALON') || cs.startsWith('SPECTRE')) {
      return 'HIGH';
    }
    
    // MEDIUM - Tanker activity (supports strike missions)
    if (cs.startsWith('LAGR') || cs.startsWith('RCH') || cs.includes('KC')) {
      return 'MEDIUM';
    }
    
    // MEDIUM - Surveillance
    if (cs.startsWith('FORTE') || cs.startsWith('RIVET') || cs.startsWith('SENIOR')) {
      return 'MEDIUM';
    }
    
    return 'LOW';
  }

  determineRegion(lat, lon) {
    if (!lat || !lon) return null;
    
    for (const [key, region] of Object.entries(REGIONS)) {
      const distance = this.calculateDistance(lat, lon, region.lat, region.lon);
      if (distance <= region.radius) {
        return {
          name: region.name,
          priority: region.priority
        };
      }
    }
    
    return null;
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    // Haversine formula (simplified for km)
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  deduplicateFlights(flights) {
    const seen = new Map();
    
    for (const flight of flights) {
      const key = flight.icao24 || flight.callsign;
      if (!seen.has(key) || flight.timestamp > seen.get(key).timestamp) {
        seen.set(key, flight);
      }
    }
    
    return Array.from(seen.values());
  }

  generateMinimalSynthetic() {
    // Generate realistic synthetic military flights for demonstration
    // These represent typical strategic aircraft patterns
    const now = Date.now() / 1000;

    // Define synthetic flight templates based on real operational patterns
    const syntheticFlights = [
      // NATO surveillance over Black Sea
      {
        icao24: 'AE5001',
        callsign: 'FORTE12',
        origin: 'USA',
        timestamp: now,
        longitude: 34.5 + (Math.random() - 0.5) * 2,
        latitude: 43.2 + (Math.random() - 0.5) * 1,
        altitude: 55000,
        velocity: 320,
        heading: 90 + Math.random() * 40,
        category: 'surveillance',
        aircraftType: 'RQ-4 Global Hawk',
        threatLevel: 'MEDIUM',
        source: 'synthetic',
        region: { name: 'Black Sea', priority: 'HIGH' },
        synthetic: true
      },
      // B-52 patrol Atlantic
      {
        icao24: 'AE5002',
        callsign: 'DEATH21',
        origin: 'USA',
        timestamp: now,
        longitude: -25.0 + (Math.random() - 0.5) * 4,
        latitude: 58.0 + (Math.random() - 0.5) * 3,
        altitude: 35000,
        velocity: 440,
        heading: 45 + Math.random() * 30,
        category: 'bombers',
        aircraftType: 'B-52H Stratofortress',
        threatLevel: 'HIGH',
        source: 'synthetic',
        region: { name: 'North Atlantic', priority: 'HIGH' },
        synthetic: true
      },
      // KC-135 tanker over Europe
      {
        icao24: 'AE5003',
        callsign: 'LAGR91',
        origin: 'USA',
        timestamp: now,
        longitude: 8.5 + (Math.random() - 0.5) * 3,
        latitude: 50.0 + (Math.random() - 0.5) * 2,
        altitude: 28000,
        velocity: 380,
        heading: 110 + Math.random() * 40,
        category: 'tankers',
        aircraftType: 'KC-135R Stratotanker',
        threatLevel: 'MEDIUM',
        source: 'synthetic',
        region: { name: 'Central Europe', priority: 'MEDIUM' },
        synthetic: true
      },
      // RC-135 SIGINT near Kaliningrad
      {
        icao24: 'AE5004',
        callsign: 'RIVET23',
        origin: 'USA',
        timestamp: now,
        longitude: 19.0 + (Math.random() - 0.5) * 2,
        latitude: 55.5 + (Math.random() - 0.5) * 1.5,
        altitude: 32000,
        velocity: 350,
        heading: 70 + Math.random() * 30,
        category: 'surveillance',
        aircraftType: 'RC-135V Rivet Joint',
        threatLevel: 'MEDIUM',
        source: 'synthetic',
        region: { name: 'Baltic Sea', priority: 'HIGH' },
        synthetic: true
      },
      // P-8 maritime patrol Persian Gulf
      {
        icao24: 'AE5005',
        callsign: 'TRIDENT7',
        origin: 'USA',
        timestamp: now,
        longitude: 54.0 + (Math.random() - 0.5) * 3,
        latitude: 26.0 + (Math.random() - 0.5) * 2,
        altitude: 25000,
        velocity: 380,
        heading: 180 + Math.random() * 60,
        category: 'surveillance',
        aircraftType: 'P-8A Poseidon',
        threatLevel: 'MEDIUM',
        source: 'synthetic',
        region: { name: 'Persian Gulf', priority: 'CRITICAL' },
        synthetic: true
      },
      // C-17 transport Middle East
      {
        icao24: 'AE5006',
        callsign: 'RCH452',
        origin: 'USA',
        timestamp: now,
        longitude: 45.0 + (Math.random() - 0.5) * 5,
        latitude: 32.0 + (Math.random() - 0.5) * 3,
        altitude: 31000,
        velocity: 420,
        heading: 90 + Math.random() * 40,
        category: 'transport',
        aircraftType: 'C-17A Globemaster III',
        threatLevel: 'LOW',
        source: 'synthetic',
        region: { name: 'Middle East', priority: 'HIGH' },
        synthetic: true
      },
      // E-3 AWACS
      {
        icao24: 'AE5007',
        callsign: 'MAGIC42',
        origin: 'USA',
        timestamp: now,
        longitude: 36.5 + (Math.random() - 0.5) * 3,
        latitude: 37.0 + (Math.random() - 0.5) * 2,
        altitude: 34000,
        velocity: 360,
        heading: 240 + Math.random() * 50,
        category: 'surveillance',
        aircraftType: 'E-3C Sentry AWACS',
        threatLevel: 'MEDIUM',
        source: 'synthetic',
        region: { name: 'Eastern Mediterranean', priority: 'HIGH' },
        synthetic: true
      },
      // MQ-9 Reaper
      {
        icao24: 'AE5008',
        callsign: 'REAPER1',
        origin: 'USA',
        timestamp: now,
        longitude: 42.5 + (Math.random() - 0.5) * 2,
        latitude: 13.5 + (Math.random() - 0.5) * 1.5,
        altitude: 22000,
        velocity: 180,
        heading: 150 + Math.random() * 40,
        category: 'uav',
        aircraftType: 'MQ-9A Reaper',
        threatLevel: 'MEDIUM',
        source: 'synthetic',
        region: { name: 'Red Sea', priority: 'CRITICAL' },
        synthetic: true
      },
      // B-1B Lancer
      {
        icao24: 'AE5009',
        callsign: 'BONE31',
        origin: 'USA',
        timestamp: now,
        longitude: -68.0 + (Math.random() - 0.5) * 4,
        latitude: 18.0 + (Math.random() - 0.5) * 2,
        altitude: 30000,
        velocity: 520,
        heading: 130 + Math.random() * 40,
        category: 'bombers',
        aircraftType: 'B-1B Lancer',
        threatLevel: 'HIGH',
        source: 'synthetic',
        region: { name: 'Caribbean', priority: 'HIGH' },
        synthetic: true
      },
      // KC-46 Pegasus Pacific
      {
        icao24: 'AE5010',
        callsign: 'NCHO77',
        origin: 'USA',
        timestamp: now,
        longitude: 125.0 + (Math.random() - 0.5) * 5,
        latitude: 25.0 + (Math.random() - 0.5) * 3,
        altitude: 26000,
        velocity: 400,
        heading: 200 + Math.random() * 50,
        category: 'tankers',
        aircraftType: 'KC-46A Pegasus',
        threatLevel: 'MEDIUM',
        source: 'synthetic',
        region: { name: 'Pacific', priority: 'HIGH' },
        synthetic: true
      },
      // AC-130J Ghostrider
      {
        icao24: 'AE5011',
        callsign: 'SPOOKY5',
        origin: 'USA',
        timestamp: now,
        longitude: 47.0 + (Math.random() - 0.5) * 2,
        latitude: 29.5 + (Math.random() - 0.5) * 1.5,
        altitude: 18000,
        velocity: 280,
        heading: 90 + Math.random() * 40,
        category: 'specialOps',
        aircraftType: 'AC-130J Ghostrider',
        threatLevel: 'HIGH',
        source: 'synthetic',
        region: { name: 'Persian Gulf', priority: 'CRITICAL' },
        synthetic: true
      },
      // E-8C JSTARS
      {
        icao24: 'AE5012',
        callsign: 'DRAGN50',
        origin: 'USA',
        timestamp: now,
        longitude: 38.0 + (Math.random() - 0.5) * 3,
        latitude: 48.0 + (Math.random() - 0.5) * 2,
        altitude: 36000,
        velocity: 340,
        heading: 75 + Math.random() * 30,
        category: 'surveillance',
        aircraftType: 'E-8C JSTARS',
        threatLevel: 'MEDIUM',
        source: 'synthetic',
        region: { name: 'Ukraine Border', priority: 'CRITICAL' },
        synthetic: true
      },
      // HC-130J Combat King II
      {
        icao24: 'AE5013',
        callsign: 'KING22',
        origin: 'USA',
        timestamp: now,
        longitude: 12.0 + (Math.random() - 0.5) * 3,
        latitude: 35.5 + (Math.random() - 0.5) * 2,
        altitude: 22000,
        velocity: 300,
        heading: 160 + Math.random() * 40,
        category: 'specialOps',
        aircraftType: 'HC-130J Combat King II',
        threatLevel: 'LOW',
        source: 'synthetic',
        region: { name: 'Mediterranean', priority: 'MEDIUM' },
        synthetic: true
      },
      // RAF Typhoon (allied)
      {
        icao24: 'UK5001',
        callsign: 'TYPHON4',
        origin: 'GBR',
        timestamp: now,
        longitude: 22.0 + (Math.random() - 0.5) * 2,
        latitude: 56.5 + (Math.random() - 0.5) * 1.5,
        altitude: 38000,
        velocity: 580,
        heading: 95 + Math.random() * 30,
        category: 'fighter',
        aircraftType: 'Eurofighter Typhoon',
        threatLevel: 'LOW',
        source: 'synthetic',
        region: { name: 'Baltic', priority: 'HIGH' },
        synthetic: true
      },
      // NATO E-3F Sentry
      {
        icao24: 'NATO01',
        callsign: 'NATO01',
        origin: 'NATO',
        timestamp: now,
        longitude: 26.0 + (Math.random() - 0.5) * 2,
        latitude: 40.0 + (Math.random() - 0.5) * 1,
        altitude: 33000,
        velocity: 360,
        heading: 80 + Math.random() * 30,
        category: 'surveillance',
        aircraftType: 'E-3A Sentry (NATO)',
        threatLevel: 'MEDIUM',
        source: 'synthetic',
        region: { name: 'Aegean Sea', priority: 'HIGH' },
        synthetic: true
      }
    ];

    // Add slight movement variation on each call
    return syntheticFlights.map(f => ({
      ...f,
      longitude: f.longitude + (Math.random() - 0.5) * 0.3,
      latitude: f.latitude + (Math.random() - 0.5) * 0.2,
      heading: (f.heading + (Math.random() - 0.5) * 10 + 360) % 360,
      timestamp: now
    }));
  }

  generateSummary() {
    const summary = {
      byCategory: {},
      byThreatLevel: {},
      byRegion: {},
      bySource: {},
      specialCallsigns: [],
      criticalAlerts: []
    };
    
    this.trackedFlights.forEach(flight => {
      // By category
      summary.byCategory[flight.category] = (summary.byCategory[flight.category] || 0) + 1;
      
      // By threat level
      summary.byThreatLevel[flight.threatLevel] = (summary.byThreatLevel[flight.threatLevel] || 0) + 1;
      
      // By source
      summary.bySource[flight.source] = (summary.bySource[flight.source] || 0) + 1;
      
      // By region
      if (flight.region) {
        summary.byRegion[flight.region.name] = (summary.byRegion[flight.region.name] || 0) + 1;
      }
      
      // Special callsigns
      const cs = (flight.callsign || '').toUpperCase();
      if (cs.startsWith('MYTEE') || cs.startsWith('NIGHT') || cs.startsWith('DEATH')) {
        summary.specialCallsigns.push(flight.callsign);
      }
      
      // Critical alerts
      if (flight.threatLevel === 'CRITICAL') {
        summary.criticalAlerts.push({
          callsign: flight.callsign,
          category: flight.category,
          region: flight.region?.name || 'Unknown'
        });
      }
    });
    
    return summary;
  }
}

module.exports = new FlightTracker();
