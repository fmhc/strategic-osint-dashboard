const WebSocket = require('ws');
const EventEmitter = require('events');

/**
 * AIS Stream Module
 * Real-time vessel tracking via AISStream.io WebSocket API
 *
 * Requires free API key from https://aisstream.io/
 * Set AISSTREAM_API_KEY in environment
 */

class AISStream extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.apiKey = process.env.AISSTREAM_API_KEY || null;
    this.vessels = new Map(); // MMSI -> vessel data
    this.alertedVessels = new Set(); // MMSIs that have already been alerted
    this.lastUpdate = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 5000;
    this.heartbeatTimer = null;       // ping/stale-detection interval
    this.lastMessageTime = 0;         // ms timestamp of last inbound frame

    // German waters bounding boxes - PRIORITY monitoring
    this.germanWatersBoxes = [
      // Hamburg approaches / Elbe estuary
      [[53.4, 8.5], [54.0, 10.5]],
      // German North Sea (Deutsche Bucht)
      [[53.5, 6.0], [55.5, 9.5]],
      // German Baltic (Ostsee)
      [[53.8, 9.5], [55.0, 14.5]],
      // Kiel Canal approaches
      [[53.8, 9.0], [54.5, 10.2]]
    ];

    // Priority areas configuration
    this.priorityAreas = {
      'german_waters': { boxes: this.germanWatersBoxes, priority: 'HIGH' },
      'hamburg_port': { boxes: [[[53.45, 9.8], [53.6, 10.1]]], priority: 'CRITICAL' },
      'kiel_canal': { boxes: [[[53.8, 9.0], [54.5, 10.2]]], priority: 'HIGH' },
      'wilhelmshaven': { boxes: [[[53.4, 8.0], [53.6, 8.3]]], priority: 'HIGH' }
    };

    // Strategic zones to monitor (reduced for performance)
    this.boundingBoxes = [
      // GERMAN WATERS - Added with priority
      // Hamburg approaches / Elbe estuary
      [[53.4, 8.5], [54.0, 10.5]],
      // German North Sea (Deutsche Bucht)
      [[53.5, 6.0], [55.5, 9.5]],
      // German Baltic (Ostsee)
      [[53.8, 9.5], [55.0, 14.5]],
      // Kiel Canal
      [[53.8, 9.0], [54.5, 10.2]],
      // Strait of Hormuz - critical chokepoint
      [[24, 54], [28, 60]],
      // English Channel - high traffic
      [[49, -2], [51, 2]],
      // Suez approaches
      [[29, 32], [31, 35]],
      // Gibraltar Strait
      [[35, -7], [37, -4]],
      // Malacca Strait - critical chokepoint
      [[0, 100], [4, 104]],
    ];

    // Vessel types of interest
    this.vesselTypesOfInterest = [
      30, // Fishing
      31, 32, // Towing
      33, // Dredging
      34, // Diving ops
      35, // Military ops
      36, // Sailing
      37, // Pleasure craft
      50, // Pilot vessel
      51, // SAR
      52, // Tug
      53, // Port tender
      55, // Law enforcement
      58, // Medical transport
      60, 61, 62, 63, 64, 65, 66, 67, 68, 69, // Passenger
      70, 71, 72, 73, 74, 75, 76, 77, 78, 79, // Cargo
      80, 81, 82, 83, 84, 85, 86, 87, 88, 89, // Tanker
    ];
  }

  /**
   * Connect to AISStream WebSocket
   */
  connect(customBoundingBoxes = null) {
    // Re-read API key in case env was loaded after constructor
    this.apiKey = process.env.AISSTREAM_API_KEY || null;

    if (!this.apiKey) {
      console.warn('[AIS] No API key configured. Set AISSTREAM_API_KEY environment variable.');
      console.warn('[AIS] Get a free key at https://aisstream.io/');
      return false;
    }

    if (this.connected) {
      console.log('[AIS] Already connected');
      return true;
    }

    try {
      this.ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

      this.ws.on('open', () => {
        console.log('[AIS] WebSocket connected');
        this.connected = true;
        this.reconnectAttempts = 0;
        this.lastMessageTime = Date.now();

        // Send subscription message
        const subscribeMsg = {
          APIKey: this.apiKey,
          BoundingBoxes: customBoundingBoxes || this.boundingBoxes
        };

        this.ws.send(JSON.stringify(subscribeMsg));
        console.log(`[AIS] Subscribed to ${subscribeMsg.BoundingBoxes.length} zones`);

        // Heartbeat: ping every 30s; if no inbound frame for 2min, terminate the
        // socket so the 'close' handler triggers a clean reconnect (no zombies).
        this.startHeartbeat();
      });

      this.ws.on('message', (data) => {
        this.lastMessageTime = Date.now();
        try {
          const message = JSON.parse(data.toString());
          this.processMessage(message);
        } catch (err) {
          console.error('[AIS] Message parse error:', err.message);
        }
      });

      this.ws.on('pong', () => { this.lastMessageTime = Date.now(); });

      this.ws.on('error', (error) => {
        console.error('[AIS] WebSocket error:', error.message);
      });

      this.ws.on('close', () => {
        console.log('[AIS] WebSocket disconnected');
        this.connected = false;
        this.stopHeartbeat();
        this.attemptReconnect();
      });

      return true;
    } catch (error) {
      console.error('[AIS] Connection error:', error.message);
      return false;
    }
  }

  /**
   * Start the ping/stale-detection heartbeat. Pings every 30s; if no inbound
   * frame (message or pong) has arrived for 2min, terminates the socket so the
   * 'close' handler reconnects — prevents silent zombie connections.
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws) return;
      if (Date.now() - this.lastMessageTime > 120000) {
        console.warn('[AIS] No data for 2min — terminating stale socket to reconnect');
        try { this.ws.terminate(); } catch (e) { try { this.ws.close(); } catch (_) {} }
        return;
      }
      try { this.ws.ping(); } catch (e) {}
    }, 30000);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Attempt to reconnect after disconnect
   */
  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[AIS] Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    console.log(`[AIS] Reconnecting in ${this.reconnectDelay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
  }

  /**
   * Process incoming AIS message
   */
  processMessage(message) {
    const msgType = message.MessageType;
    const metaData = message.MetaData;
    const aisMessage = message.Message;

    if (!metaData || !aisMessage) return;

    const mmsi = metaData.MMSI?.toString();
    if (!mmsi) return;

    // Get or create vessel record
    let vessel = this.vessels.get(mmsi) || {
      mmsi,
      positions: []
    };

    // Update based on message type
    if (msgType === 'PositionReport') {
      const pos = aisMessage.PositionReport;
      vessel = {
        ...vessel,
        mmsi,
        name: metaData.ShipName?.trim() || vessel.name || 'Unknown',
        latitude: pos.Latitude,
        longitude: pos.Longitude,
        course: pos.Cog, // Course over ground
        speed: pos.Sog, // Speed over ground (knots)
        heading: pos.TrueHeading,
        navStatus: this.getNavStatus(pos.NavigationalStatus),
        timestamp: new Date(metaData.time_utc || Date.now()),
        lastUpdate: new Date()
      };

      // Keep last 10 positions for track history
      vessel.positions.push({
        lat: pos.Latitude,
        lon: pos.Longitude,
        time: new Date()
      });
      if (vessel.positions.length > 10) {
        vessel.positions.shift();
      }
    }

    if (msgType === 'ShipStaticData') {
      const staticData = aisMessage.ShipStaticData;
      vessel = {
        ...vessel,
        mmsi,
        name: staticData.Name?.trim() || vessel.name,
        imo: staticData.ImoNumber || vessel.imo,
        callsign: staticData.CallSign || vessel.callsign,
        shipType: staticData.Type || vessel.shipType,
        shipTypeName: this.getShipTypeName(staticData.Type),
        destination: staticData.Destination?.trim() || vessel.destination,
        eta: staticData.Eta ? this.parseEta(staticData.Eta) : vessel.eta,
        dimensions: {
          length: (staticData.Dimension?.A || 0) + (staticData.Dimension?.B || 0),
          width: (staticData.Dimension?.C || 0) + (staticData.Dimension?.D || 0)
        },
        draught: staticData.MaximumStaticDraught || vessel.draught
      };
    }

    // Check if vessel is in German waters
    const germanCheck = this.isGermanWatersVessel(vessel);
    if (germanCheck.inGermanWaters) {
      vessel.germanWaters = true;
      vessel.germanZone = germanCheck.zone;
      // Elevate priority for German waters vessels
      if (!vessel.priority || vessel.priority === 'LOW') {
        vessel.priority = 'MEDIUM';
      }
      if (germanCheck.zone === 'hamburg_port') {
        vessel.priority = 'HIGH';
      }
    } else {
      vessel.germanWaters = false;
      vessel.germanZone = null;
    }

    // Update vessel in map
    this.vessels.set(mmsi, vessel);
    this.lastUpdate = new Date();

    // Emit update event
    this.emit('vessel-update', vessel);

    // Check for vessels of interest (only alert once per vessel)
    if (this.isVesselOfInterest(vessel) && !this.alertedVessels.has(mmsi)) {
      this.alertedVessels.add(mmsi);
      this.emit('vessel-alert', vessel);
    }

    // Emit German waters alert for military vessels entering German waters
    if (germanCheck.inGermanWaters && vessel.shipType === 35) {
      this.emit('german-waters-military', vessel);
    }
  }

  /**
   * Check if vessel is in German waters
   */
  isGermanWatersVessel(vessel) {
    const { latitude, longitude } = vessel;
    if (!latitude || !longitude) return { inGermanWaters: false, zone: null };

    // Check against German waters bounding boxes
    for (const [[minLat, minLon], [maxLat, maxLon]] of this.germanWatersBoxes) {
      if (latitude >= minLat && latitude <= maxLat &&
          longitude >= minLon && longitude <= maxLon) {

        // Determine specific zone
        let zone = 'german_waters';
        if (latitude >= 53.45 && latitude <= 53.6 && longitude >= 9.8 && longitude <= 10.1) {
          zone = 'hamburg_port';
        } else if (latitude >= 53.8 && latitude <= 54.5 && longitude >= 9.0 && longitude <= 10.2) {
          zone = 'kiel_canal';
        } else if (longitude <= 9.5) {
          zone = 'north_sea_german';
        } else {
          zone = 'baltic_german';
        }

        return { inGermanWaters: true, zone };
      }
    }

    return { inGermanWaters: false, zone: null };
  }

  /**
   * Check if vessel is of strategic interest
   * More restrictive to avoid alert spam
   */
  isVesselOfInterest(vessel) {
    // Military vessels (type 35) - always interesting
    if (vessel.shipType === 35) return true;

    // Law enforcement (type 55) - only if actively moving
    if (vessel.shipType === 55 && vessel.speed > 5) return true;

    // Search and Rescue (type 51) - only if actively moving (may be on operation)
    if (vessel.shipType === 51 && vessel.speed > 8) return true;

    // Truly exceptional vessels over 380m (aircraft carriers, ULCVs)
    if (vessel.dimensions?.length > 380) return true;

    // Vessels traveling at extremely high speed (over 35 knots - very unusual)
    if (vessel.speed > 35) return true;

    // Specific vessel names of high interest (case insensitive)
    const name = (vessel.name || '').toLowerCase();
    const interestingNames = ['warship', 'navy', 'nuclear'];
    if (interestingNames.some(n => name.includes(n))) return true;

    return false;
  }

  /**
   * Get navigation status string
   */
  getNavStatus(code) {
    const statuses = {
      0: 'Under way using engine',
      1: 'At anchor',
      2: 'Not under command',
      3: 'Restricted manoeuverability',
      4: 'Constrained by draught',
      5: 'Moored',
      6: 'Aground',
      7: 'Engaged in fishing',
      8: 'Under way sailing',
      11: 'Power-driven vessel towing astern',
      12: 'Power-driven vessel pushing ahead',
      14: 'AIS-SART active',
      15: 'Undefined'
    };
    return statuses[code] || 'Unknown';
  }

  /**
   * Get ship type name from AIS type code
   */
  getShipTypeName(code) {
    if (!code) return 'Unknown';

    if (code >= 20 && code <= 29) return 'Wing in Ground';
    if (code === 30) return 'Fishing';
    if (code >= 31 && code <= 32) return 'Towing';
    if (code === 33) return 'Dredging';
    if (code === 34) return 'Diving Operations';
    if (code === 35) return 'Military Operations';
    if (code === 36) return 'Sailing';
    if (code === 37) return 'Pleasure Craft';
    if (code >= 40 && code <= 49) return 'High Speed Craft';
    if (code === 50) return 'Pilot Vessel';
    if (code === 51) return 'Search and Rescue';
    if (code === 52) return 'Tug';
    if (code === 53) return 'Port Tender';
    if (code === 55) return 'Law Enforcement';
    if (code === 58) return 'Medical Transport';
    if (code >= 60 && code <= 69) return 'Passenger';
    if (code >= 70 && code <= 79) return 'Cargo';
    if (code >= 80 && code <= 89) return 'Tanker';
    if (code >= 90 && code <= 99) return 'Other';

    return 'Unknown';
  }

  /**
   * Parse ETA from AIS format
   */
  parseEta(eta) {
    if (!eta) return null;
    try {
      const month = eta.Month;
      const day = eta.Day;
      const hour = eta.Hour;
      const minute = eta.Minute;

      if (month === 0 && day === 0) return null;

      const now = new Date();
      const year = now.getFullYear();
      const etaDate = new Date(year, month - 1, day, hour, minute);

      // If ETA is in the past, assume next year
      if (etaDate < now) {
        etaDate.setFullYear(year + 1);
      }

      return etaDate;
    } catch {
      return null;
    }
  }

  /**
   * Get slim vessel object without position history (for broadcasts)
   */
  getSlimVessel(v) {
    return {
      mmsi: v.mmsi,
      name: v.name,
      latitude: v.latitude,
      longitude: v.longitude,
      course: v.course,
      speed: v.speed,
      heading: v.heading,
      navStatus: v.navStatus,
      shipType: v.shipType,
      shipTypeName: v.shipTypeName,
      destination: v.destination,
      dimensions: v.dimensions,
      lastUpdate: v.lastUpdate
    };
  }

  /**
   * Get vessels in German waters only
   */
  getGermanWatersVessels(options = {}) {
    const { maxAge, slim } = options;
    let vessels = Array.from(this.vessels.values())
      .filter(v => v.germanWaters === true);

    // Filter by max age (in minutes)
    if (maxAge) {
      const cutoff = new Date(Date.now() - maxAge * 60 * 1000);
      vessels = vessels.filter(v => v.lastUpdate > cutoff);
    }

    // Group by zone
    const byZone = {
      hamburg_port: [],
      kiel_canal: [],
      north_sea_german: [],
      baltic_german: [],
      german_waters: []
    };

    vessels.forEach(v => {
      const zone = v.germanZone || 'german_waters';
      if (byZone[zone]) {
        byZone[zone].push(slim ? this.getSlimVessel(v) : v);
      }
    });

    return {
      timestamp: this.lastUpdate || new Date(),
      count: vessels.length,
      byZone,
      vessels: slim ? vessels.map(v => this.getSlimVessel(v)) : vessels
    };
  }

  /**
   * Get all tracked vessels
   */
  getVessels(options = {}) {
    const { type, minSpeed, maxAge, maxVessels, slim, germanWatersOnly } = options;
    let vessels = Array.from(this.vessels.values());

    // Filter for German waters only if requested
    if (germanWatersOnly) {
      vessels = vessels.filter(v => v.germanWaters === true);
    }

    // Limit total vessels for performance (default 500)
    const limit = maxVessels || 500;

    // Filter by vessel type
    if (type) {
      vessels = vessels.filter(v =>
        v.shipTypeName?.toLowerCase().includes(type.toLowerCase())
      );
    }

    // Filter by minimum speed
    if (minSpeed) {
      vessels = vessels.filter(v => v.speed >= minSpeed);
    }

    // Filter by max age (in minutes)
    if (maxAge) {
      const cutoff = new Date(Date.now() - maxAge * 60 * 1000);
      vessels = vessels.filter(v => v.lastUpdate > cutoff);
    }

    // Apply limit
    let limitedVessels = vessels.slice(0, limit);

    // Return slim objects if requested (removes position history)
    if (slim) {
      limitedVessels = limitedVessels.map(v => this.getSlimVessel(v));
    }

    return {
      timestamp: this.lastUpdate || new Date(),
      count: vessels.length,
      connected: this.connected,
      vessels: limitedVessels,
      summary: this.generateSummary(vessels.slice(0, limit))
    };
  }

  /**
   * Generate summary statistics
   */
  generateSummary(vessels) {
    const byType = {};
    const byStatus = {};
    let totalSpeed = 0;
    let speedCount = 0;

    vessels.forEach(v => {
      const type = v.shipTypeName || 'Unknown';
      byType[type] = (byType[type] || 0) + 1;

      const status = v.navStatus || 'Unknown';
      byStatus[status] = (byStatus[status] || 0) + 1;

      if (v.speed && v.speed > 0) {
        totalSpeed += v.speed;
        speedCount++;
      }
    });

    return {
      byType,
      byStatus,
      averageSpeed: speedCount > 0 ? (totalSpeed / speedCount).toFixed(1) : 0,
      underway: vessels.filter(v => v.speed > 0.5).length,
      anchored: vessels.filter(v => v.navStatus === 'At anchor' || v.navStatus === 'Moored').length
    };
  }

  /**
   * Get vessels as GeoJSON
   */
  toGeoJSON() {
    const vessels = Array.from(this.vessels.values()).filter(v => v.latitude && v.longitude);

    return {
      type: 'FeatureCollection',
      features: vessels.map(v => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [v.longitude, v.latitude]
        },
        properties: {
          mmsi: v.mmsi,
          name: v.name,
          imo: v.imo,
          callsign: v.callsign,
          type: v.shipTypeName,
          typeCode: v.shipType,
          speed: v.speed,
          course: v.course,
          heading: v.heading,
          navStatus: v.navStatus,
          destination: v.destination,
          length: v.dimensions?.length,
          width: v.dimensions?.width,
          timestamp: v.timestamp
        }
      }))
    };
  }

  /**
   * Disconnect WebSocket
   */
  disconnect() {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
      console.log('[AIS] Disconnected');
    }
  }

  /**
   * Clear old vessel data
   */
  cleanup(maxAgeMinutes = 30) {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
    let removed = 0;

    for (const [mmsi, vessel] of this.vessels) {
      if (vessel.lastUpdate < cutoff) {
        this.vessels.delete(mmsi);
        this.alertedVessels.delete(mmsi); // Allow re-alert if vessel returns
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[AIS] Cleaned up ${removed} stale vessel records`);
    }
  }
}

module.exports = new AISStream();
