const axios = require('axios');
const OsintModule = require('./base-module');

/**
 * Tor Exit Nodes Module
 * 
 * Sources active Tor exit nodes from the Tor Project's bulk exit list
 * URL: https://check.torproject.org/torbulkexitlist
 */

class TorExitsModule extends OsintModule {
  constructor() {
    super();
    this.name = 'tor-exits';
    this.displayName = 'Tor Exit Nodes';
    this.icon = '🧅';
    this.category = 'cyber';
    this.schedule = '0 * * * *';  // Every hour (Tor list updates hourly)
    this.enabled = true;
    this.requiresEnv = [];
    
    this.cache = new Map();
    this.cacheTimeout = 3300000; // 55 minutes (list updates hourly)
    this.previousCount = 0;
  }

  async update() {
    try {
      const [exitList, additionalData] = await Promise.allSettled([
        this.fetchExitNodes(),
        this.fetchAdditionalMetrics()
      ]);

      let nodes = [];
      let metrics = {};
      
      if (exitList.status === 'fulfilled') {
        nodes = exitList.value;
      }
      
      if (additionalData.status === 'fulfilled') {
        metrics = additionalData.value;
      }

      // Analyze trends
      const trend = this.analyzeTrend(nodes.length);
      
      // Geolocate nodes (basic analysis)
      const geographic = await this.analyzeGeographic(nodes);

      return this.sanitizeData({
        timestamp: new Date(),
        count: nodes.length,
        exitNodes: nodes.slice(0, 1000), // Limit to first 1000 for performance
        trend: trend,
        geographic: geographic,
        metrics: metrics,
        summary: this.generateSummary(nodes, trend, geographic),
        previousCount: this.previousCount
      });
    } catch (error) {
      console.error('[TOR] Error:', error.message);
      return this.sanitizeData({
        timestamp: new Date(),
        count: 0,
        exitNodes: [],
        error: error.message
      });
    }
  }

  async fetchExitNodes() {
    try {
      const cached = this.cache.get('exitnodes');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      console.log('[TOR] Fetching Tor exit node list...');
      
      // Tor Project's official bulk exit list
      const response = await axios.get('https://check.torproject.org/torbulkexitlist', {
        timeout: 30000,
        headers: {
          'User-Agent': 'OSINTExplorer/1.0 (Tor Network Monitoring)'
        }
      });

      if (!response.data) {
        return [];
      }

      // Parse IP addresses from the response
      const ips = response.data
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .filter(line => this.isValidIP(line));

      const nodes = ips.map(ip => ({
        ip: ip,
        timestamp: new Date(),
        source: 'torproject.org',
        type: 'exit_node',
        country: null, // Will be populated by geographic analysis
        asn: null,
        isp: null
      }));

      this.cache.set('exitnodes', { data: nodes, time: Date.now() });
      console.log(`[TOR] Exit nodes: ${nodes.length}`);
      return nodes;
    } catch (error) {
      console.error('[TOR] Exit nodes error:', error.message);
      return [];
    }
  }

  async fetchAdditionalMetrics() {
    try {
      // Could fetch additional metrics from Tor Metrics API here
      // For now, return basic computed metrics
      return {
        networkStatus: 'active',
        consensusTime: new Date(),
        relayCount: null, // Would need Tor Metrics API
        bridgeCount: null,
        totalBandwidth: null
      };
    } catch (error) {
      console.error('[TOR] Additional metrics error:', error.message);
      return {};
    }
  }

  isValidIP(str) {
    // Basic IPv4 validation
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    return ipv4Regex.test(str);
  }

  analyzeTrend(currentCount) {
    const change = currentCount - this.previousCount;
    const changePercent = this.previousCount > 0 ? 
      ((change / this.previousCount) * 100).toFixed(2) : 0;
    
    let trendDirection = 'stable';
    if (Math.abs(change) > 50) {
      trendDirection = change > 0 ? 'increasing' : 'decreasing';
    }

    const trend = {
      direction: trendDirection,
      change: change,
      changePercent: parseFloat(changePercent),
      previous: this.previousCount,
      current: currentCount
    };

    // Update previous count for next analysis
    this.previousCount = currentCount;
    
    return trend;
  }

  async analyzeGeographic(nodes) {
    // Basic geographic distribution analysis
    // In a production system, you'd use a GeoIP database
    
    const ipRanges = {
      'US': ['192.168.', '10.', '172.16.'], // Placeholder - need real GeoIP
      'EU': ['85.', '86.', '87.'],
      'Asia': ['103.', '104.', '105.'],
      'Other': []
    };

    const distribution = {
      'US': 0,
      'EU': 0,
      'Asia': 0,
      'Other': 0
    };

    // Simple classification based on IP ranges (very basic)
    nodes.forEach(node => {
      let classified = false;
      for (const [region, ranges] of Object.entries(ipRanges)) {
        if (region === 'Other') continue;
        
        for (const range of ranges) {
          if (node.ip.startsWith(range)) {
            distribution[region]++;
            classified = true;
            break;
          }
        }
        
        if (classified) break;
      }
      
      if (!classified) {
        distribution['Other']++;
      }
    });

    // Calculate percentages
    const total = nodes.length;
    const percentages = {};
    for (const [region, count] of Object.entries(distribution)) {
      percentages[region] = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
    }

    return {
      distribution,
      percentages,
      total,
      dominantRegion: Object.entries(distribution).sort((a, b) => b[1] - a[1])[0]
    };
  }

  generateSummary(nodes, trend, geographic) {
    return {
      total: nodes.length,
      trend: trend,
      geographic: geographic,
      networkHealth: this.assessNetworkHealth(nodes.length, trend),
      riskLevel: this.calculateRiskLevel(nodes.length, trend),
      lastUpdated: new Date(),
      dataFreshness: 'hourly',
      coverage: 'global'
    };
  }

  assessNetworkHealth(count, trend) {
    // Assess Tor network health based on exit node count
    if (count < 1000) return 'poor';
    if (count < 1500) return 'fair';
    if (count < 2000) return 'good';
    return 'excellent';
  }

  calculateRiskLevel(count, trend) {
    // Calculate risk level for operational security
    
    // Significant decrease in exit nodes could indicate:
    // - Network attack
    // - Government interference
    // - Technical issues
    
    if (trend.direction === 'decreasing' && Math.abs(trend.changePercent) > 20) {
      return 'HIGH';
    }
    
    if (count < 800) {
      return 'HIGH'; // Very low exit node count
    }
    
    if (trend.direction === 'decreasing' && Math.abs(trend.changePercent) > 10) {
      return 'MEDIUM';
    }
    
    return 'LOW';
  }

  getDefaultState() {
    return {
      timestamp: null,
      count: 0,
      exitNodes: [],
      trend: {
        direction: 'stable',
        change: 0,
        changePercent: 0,
        previous: 0,
        current: 0
      },
      geographic: {
        distribution: {},
        percentages: {},
        total: 0,
        dominantRegion: null
      },
      summary: {
        total: 0,
        networkHealth: 'unknown',
        riskLevel: 'LOW'
      }
    };
  }

  getAlerts(data) {
    const alerts = [];
    
    // Alert on significant network changes
    if (data.trend && data.trend.direction === 'decreasing' && Math.abs(data.trend.changePercent) > 15) {
      alerts.push({
        id: `tor_network_decline_${Date.now()}`,
        type: 'TOR_NETWORK',
        severity: 'HIGH',
        message: `Tor network decline: ${Math.abs(data.trend.change)} exit nodes lost (${data.trend.changePercent}%)`,
        timestamp: new Date(),
        data: { trend: data.trend }
      });
    }
    
    // Alert on very low exit node count
    if (data.count < 800) {
      alerts.push({
        id: `tor_low_count_${Date.now()}`,
        type: 'TOR_NETWORK',
        severity: 'CRITICAL',
        message: `Critical: Only ${data.count} Tor exit nodes active (below safe threshold)`,
        timestamp: new Date(),
        data: { count: data.count, threshold: 800 }
      });
    }
    
    // Alert on major network increase (could indicate compromise)
    if (data.trend && data.trend.direction === 'increasing' && data.trend.changePercent > 30) {
      alerts.push({
        id: `tor_network_surge_${Date.now()}`,
        type: 'TOR_NETWORK',
        severity: 'MEDIUM',
        message: `Unusual Tor network surge: ${data.trend.change} new exit nodes (+${data.trend.changePercent}%)`,
        timestamp: new Date(),
        data: { trend: data.trend }
      });
    }
    
    return alerts;
  }
}

module.exports = new TorExitsModule();
