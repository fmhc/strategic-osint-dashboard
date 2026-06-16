/**
 * Alert System Module
 * Creates and manages alerts based on thresholds
 */

class AlertSystem {
  constructor() {
    this.alertId = 0;
  }

  createAlert(source, severity, message, data = {}) {
    this.alertId++;
    
    return {
      id: this.alertId,
      source: source,
      severity: severity,
      message: message,
      data: data,
      timestamp: new Date(),
      acknowledged: false
    };
  }

  assessThreatLevel(globalState) {
    let score = 0;
    
    // Pizza Index
    if (globalState.pizzaIndex && globalState.pizzaIndex.value > 1000) score += 5;
    else if (globalState.pizzaIndex && globalState.pizzaIndex.value > 500) score += 3;
    else if (globalState.pizzaIndex && globalState.pizzaIndex.value > 300) score += 1;
    
    // GPS Jamming
    if (globalState.signals && globalState.signals.gpsJamming) {
      if (globalState.signals.gpsJamming.length > 3) score += 4;
      else if (globalState.signals.gpsJamming.length > 1) score += 2;
    }
    
    // EAMs
    if (globalState.signals && globalState.signals.eams) {
      if (globalState.signals.eams.length > 40) score += 4;
      else if (globalState.signals.eams.length > 20) score += 2;
    }
    
    // Strategic flights
    if (globalState.flights && globalState.flights.length > 20) score += 2;
    
    if (score >= 10) return { level: 'CRITICAL', color: '#FF0000', description: 'Military action imminent or ongoing' };
    if (score >= 7) return { level: 'HIGH', color: '#FF6600', description: 'High probability of military action within 24-48h' };
    if (score >= 4) return { level: 'ELEVATED', color: '#FFCC00', description: 'Increased military readiness detected' };
    if (score >= 2) return { level: 'MEDIUM', color: '#FFFF00', description: 'Above normal activity' };
    return { level: 'NORMAL', color: '#00FF00', description: 'Routine operations' };
  }
}

module.exports = new AlertSystem();

