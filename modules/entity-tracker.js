const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

/**
 * Entity Tracker Module
 *
 * Tracks entities of interest (flights, vessels) based on configurable watchlists.
 * Provides matching, tracking history, and priority classification.
 */

class EntityTracker extends EventEmitter {
  constructor() {
    super();
    this.entitiesPath = path.join(__dirname, '..', 'data', 'entities-of-interest.json');
    this.entities = null;
    this.trackedFlights = new Map(); // callsign -> tracking info
    this.trackedVessels = new Map(); // mmsi -> tracking info
    this.flightHistory = new Map(); // callsign -> position history
    this.vesselHistory = new Map(); // mmsi -> position history
    this.maxHistoryLength = 100;
    this.loadEntitiesOfInterest();
  }

  /**
   * Load entities of interest from JSON file
   */
  loadEntitiesOfInterest() {
    try {
      if (fs.existsSync(this.entitiesPath)) {
        const data = fs.readFileSync(this.entitiesPath, 'utf8');
        this.entities = JSON.parse(data);
        console.log('[ENTITY-TRACKER] Loaded entities of interest');
        console.log(`[ENTITY-TRACKER] Flight watchlist: ${this.entities.flights?.watchlist?.length || 0} patterns`);
        console.log(`[ENTITY-TRACKER] Vessel watchlist: ${this.entities.vessels?.watchlist?.length || 0} patterns`);
        console.log(`[ENTITY-TRACKER] Carriers: ${this.entities.vessels?.carriers?.length || 0}`);
        return true;
      }
    } catch (error) {
      console.error('[ENTITY-TRACKER] Error loading entities:', error.message);
    }

    // Initialize with defaults if file doesn't exist
    this.entities = {
      flights: { watchlist: [], tracked: [] },
      vessels: { watchlist: [], carriers: [], submarines: [], tracked: [] },
      german_focus: { harbours: [], airbases: [], aoi_bbox: {} }
    };
    return false;
  }

  /**
   * Reload entities from file (for runtime updates)
   */
  reload() {
    return this.loadEntitiesOfInterest();
  }

  /**
   * Check if a flight matches watchlist patterns
   * @param {Object} flight - Flight object with callsign, type, etc.
   * @returns {Object|null} Match result with priority and type, or null
   */
  matchFlight(flight) {
    if (!this.entities?.flights?.watchlist) return null;

    const callsign = (flight.callsign || '').toUpperCase().trim();
    if (!callsign) return null;

    for (const pattern of this.entities.flights.watchlist) {
      const patternStr = pattern.callsign.replace('*', '');

      // Check if callsign matches pattern (supports prefix matching with *)
      if (pattern.callsign.endsWith('*')) {
        if (callsign.startsWith(patternStr)) {
          return {
            matched: true,
            pattern: pattern.callsign,
            type: pattern.type,
            priority: pattern.priority,
            notes: pattern.notes,
            callsign: callsign
          };
        }
      } else if (callsign === pattern.callsign.toUpperCase()) {
        return {
          matched: true,
          pattern: pattern.callsign,
          type: pattern.type,
          priority: pattern.priority,
          notes: pattern.notes,
          callsign: callsign
        };
      }
    }

    return null;
  }

  /**
   * Check if a vessel matches watchlist patterns
   * @param {Object} vessel - Vessel object with mmsi, name, shipType, etc.
   * @returns {Object|null} Match result with priority and type, or null
   */
  matchVessel(vessel) {
    if (!this.entities?.vessels) return null;

    const mmsi = (vessel.mmsi || '').toString();
    const name = (vessel.name || '').toUpperCase().trim();
    const shipType = vessel.shipType;

    // Check carriers first (high priority)
    if (this.entities.vessels.carriers) {
      for (const carrier of this.entities.vessels.carriers) {
        const carrierName = carrier.name.toUpperCase();
        if (name.includes(carrierName.replace('USS ', '')) || name === carrierName) {
          return {
            matched: true,
            type: 'aircraft_carrier',
            priority: 'CRITICAL',
            notes: `${carrier.class}-class carrier ${carrier.hull}`,
            hull: carrier.hull,
            vesselName: name
          };
        }
      }
    }

    // Check submarines indicators
    if (this.entities.vessels.submarines) {
      for (const subType of this.entities.vessels.submarines) {
        for (const indicator of subType.indicators || []) {
          if (name.includes(indicator.toUpperCase())) {
            return {
              matched: true,
              type: subType.type,
              priority: subType.priority,
              notes: subType.notes,
              vesselName: name
            };
          }
        }
      }
    }

    // Check general watchlist
    if (this.entities.vessels.watchlist) {
      for (const pattern of this.entities.vessels.watchlist) {
        // Match by MMSI prefix
        if (pattern.mmsi_prefix && mmsi.startsWith(pattern.mmsi_prefix)) {
          return {
            matched: true,
            type: pattern.type,
            priority: pattern.priority,
            notes: pattern.notes,
            vesselName: name
          };
        }

        // Match by ship type
        if (pattern.shipType && shipType === pattern.shipType) {
          return {
            matched: true,
            type: pattern.type,
            priority: pattern.priority,
            notes: pattern.notes,
            vesselName: name
          };
        }

        // Match by name pattern
        if (pattern.name) {
          const patternStr = pattern.name.replace(/\*/g, '');
          const patternUpper = patternStr.toUpperCase();

          if (pattern.name.startsWith('*') && pattern.name.endsWith('*')) {
            // Contains match
            if (name.includes(patternUpper)) {
              return {
                matched: true,
                type: pattern.type,
                priority: pattern.priority,
                notes: pattern.notes,
                vesselName: name
              };
            }
          } else if (pattern.name.endsWith('*')) {
            // Prefix match
            if (name.startsWith(patternUpper)) {
              return {
                matched: true,
                type: pattern.type,
                priority: pattern.priority,
                notes: pattern.notes,
                vesselName: name
              };
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Track an entity (add to tracked list with timestamp)
   * @param {string} type - 'flight' or 'vessel'
   * @param {Object} entity - Entity data
   * @param {Object} matchInfo - Match information from matchFlight/matchVessel
   */
  trackEntity(type, entity, matchInfo) {
    const timestamp = new Date();

    if (type === 'flight') {
      const callsign = entity.callsign || entity.id;
      const existing = this.trackedFlights.get(callsign);

      const trackingInfo = {
        callsign,
        firstSeen: existing?.firstSeen || timestamp,
        lastSeen: timestamp,
        matchInfo,
        ...entity,
        updateCount: (existing?.updateCount || 0) + 1
      };

      this.trackedFlights.set(callsign, trackingInfo);

      // Add to history
      this.addToHistory(this.flightHistory, callsign, {
        lat: entity.latitude,
        lon: entity.longitude,
        altitude: entity.altitude,
        heading: entity.heading,
        speed: entity.velocity,
        timestamp
      });

      // Emit event for new high-priority flights
      if (!existing && (matchInfo.priority === 'CRITICAL' || matchInfo.priority === 'HIGH')) {
        this.emit('priority-flight', trackingInfo);
      }

    } else if (type === 'vessel') {
      const mmsi = entity.mmsi || entity.id;
      const existing = this.trackedVessels.get(mmsi);

      const trackingInfo = {
        mmsi,
        firstSeen: existing?.firstSeen || timestamp,
        lastSeen: timestamp,
        matchInfo,
        ...entity,
        updateCount: (existing?.updateCount || 0) + 1
      };

      this.trackedVessels.set(mmsi, trackingInfo);

      // Add to history
      this.addToHistory(this.vesselHistory, mmsi, {
        lat: entity.latitude,
        lon: entity.longitude,
        course: entity.course,
        speed: entity.speed,
        timestamp
      });

      // Emit event for new high-priority vessels
      if (!existing && (matchInfo.priority === 'CRITICAL' || matchInfo.priority === 'HIGH')) {
        this.emit('priority-vessel', trackingInfo);
      }
    }
  }

  /**
   * Add position to entity history
   */
  addToHistory(historyMap, id, position) {
    if (!historyMap.has(id)) {
      historyMap.set(id, []);
    }

    const history = historyMap.get(id);
    history.push(position);

    // Trim history if too long
    if (history.length > this.maxHistoryLength) {
      history.shift();
    }
  }

  /**
   * Get all currently tracked entities
   */
  getTrackedEntities() {
    const flights = Array.from(this.trackedFlights.values());
    const vessels = Array.from(this.trackedVessels.values());

    return {
      timestamp: new Date(),
      flights: {
        count: flights.length,
        critical: flights.filter(f => f.matchInfo?.priority === 'CRITICAL').length,
        high: flights.filter(f => f.matchInfo?.priority === 'HIGH').length,
        items: flights.sort((a, b) => {
          const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
          return (priorityOrder[a.matchInfo?.priority] || 3) - (priorityOrder[b.matchInfo?.priority] || 3);
        })
      },
      vessels: {
        count: vessels.length,
        critical: vessels.filter(v => v.matchInfo?.priority === 'CRITICAL').length,
        high: vessels.filter(v => v.matchInfo?.priority === 'HIGH').length,
        items: vessels.sort((a, b) => {
          const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
          return (priorityOrder[a.matchInfo?.priority] || 3) - (priorityOrder[b.matchInfo?.priority] || 3);
        })
      }
    };
  }

  /**
   * Get priority flights only
   */
  getPriorityFlights() {
    return Array.from(this.trackedFlights.values())
      .filter(f => f.matchInfo?.priority === 'CRITICAL' || f.matchInfo?.priority === 'HIGH')
      .sort((a, b) => {
        const priorityOrder = { CRITICAL: 0, HIGH: 1 };
        return (priorityOrder[a.matchInfo?.priority] || 1) - (priorityOrder[b.matchInfo?.priority] || 1);
      });
  }

  /**
   * Get priority vessels only
   */
  getPriorityVessels() {
    return Array.from(this.trackedVessels.values())
      .filter(v => v.matchInfo?.priority === 'CRITICAL' || v.matchInfo?.priority === 'HIGH')
      .sort((a, b) => {
        const priorityOrder = { CRITICAL: 0, HIGH: 1 };
        return (priorityOrder[a.matchInfo?.priority] || 1) - (priorityOrder[b.matchInfo?.priority] || 1);
      });
  }

  /**
   * Get entity history by ID
   */
  getEntityHistory(type, id) {
    if (type === 'flight') {
      return {
        entity: this.trackedFlights.get(id),
        positions: this.flightHistory.get(id) || []
      };
    } else if (type === 'vessel') {
      return {
        entity: this.trackedVessels.get(id),
        positions: this.vesselHistory.get(id) || []
      };
    }
    return null;
  }

  /**
   * Check if position is within German waters AOI
   */
  isInGermanWaters(lat, lon) {
    if (!this.entities?.german_focus?.aoi_bbox) return false;

    const boxes = this.entities.german_focus.aoi_bbox;

    for (const [name, bbox] of Object.entries(boxes)) {
      if (Array.isArray(bbox) && bbox.length === 2) {
        const [[minLat, minLon], [maxLat, maxLon]] = bbox;
        if (lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon) {
          return { inGermanWaters: true, zone: name };
        }
      }
    }

    return { inGermanWaters: false, zone: null };
  }

  /**
   * Get German focus configuration
   */
  getGermanFocus() {
    return this.entities?.german_focus || null;
  }

  /**
   * Get analysis triggers configuration
   */
  getAnalysisTriggers() {
    return this.entities?.analysis_triggers || {
      flight: {},
      vessel: {}
    };
  }

  /**
   * Clean up stale tracked entities
   * @param {number} maxAgeMinutes - Maximum age in minutes
   */
  cleanup(maxAgeMinutes = 30) {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
    let removedFlights = 0;
    let removedVessels = 0;

    for (const [callsign, flight] of this.trackedFlights) {
      if (flight.lastSeen < cutoff) {
        this.trackedFlights.delete(callsign);
        this.flightHistory.delete(callsign);
        removedFlights++;
      }
    }

    for (const [mmsi, vessel] of this.trackedVessels) {
      if (vessel.lastSeen < cutoff) {
        this.trackedVessels.delete(mmsi);
        this.vesselHistory.delete(mmsi);
        removedVessels++;
      }
    }

    if (removedFlights > 0 || removedVessels > 0) {
      console.log(`[ENTITY-TRACKER] Cleanup: removed ${removedFlights} flights, ${removedVessels} vessels`);
    }
  }

  /**
   * Get summary statistics
   */
  getSummary() {
    const flights = Array.from(this.trackedFlights.values());
    const vessels = Array.from(this.trackedVessels.values());

    const flightsByType = {};
    const flightsByPriority = {};
    flights.forEach(f => {
      const type = f.matchInfo?.type || 'unknown';
      const priority = f.matchInfo?.priority || 'UNKNOWN';
      flightsByType[type] = (flightsByType[type] || 0) + 1;
      flightsByPriority[priority] = (flightsByPriority[priority] || 0) + 1;
    });

    const vesselsByType = {};
    const vesselsByPriority = {};
    vessels.forEach(v => {
      const type = v.matchInfo?.type || 'unknown';
      const priority = v.matchInfo?.priority || 'UNKNOWN';
      vesselsByType[type] = (vesselsByType[type] || 0) + 1;
      vesselsByPriority[priority] = (vesselsByPriority[priority] || 0) + 1;
    });

    return {
      timestamp: new Date(),
      flights: {
        total: flights.length,
        byType: flightsByType,
        byPriority: flightsByPriority
      },
      vessels: {
        total: vessels.length,
        byType: vesselsByType,
        byPriority: vesselsByPriority
      }
    };
  }
}

module.exports = new EntityTracker();
