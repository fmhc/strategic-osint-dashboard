const axios = require('axios');
const Parser = require('rss-parser');
const OsintModule = require('./base-module');

/**
 * WHO Disease Outbreaks Module
 * 
 * Sources disease outbreak reports from WHO Disease Outbreak News (DON)
 * RSS: https://www.who.int/feeds/entity/don/en/rss.xml
 */

class WhoOutbreaksModule extends OsintModule {
  constructor() {
    super();
    this.name = 'who-outbreaks';
    this.displayName = 'WHO Disease Outbreaks';
    this.icon = '🦠';
    this.category = 'intel';
    this.schedule = '*/30 * * * *';  // Every 30 minutes
    this.enabled = true;
    this.requiresEnv = [];
    
    this.parser = new Parser({
      timeout: 15000,
      headers: {
        'User-Agent': 'OSINTExplorer/1.0 (Disease Monitoring)'
      }
    });
    
    this.cache = new Map();
    this.cacheTimeout = 900000; // 15 minutes
  }

  async update() {
    try {
      const [donReports, additionalSources] = await Promise.allSettled([
        this.fetchDONReports(),
        this.fetchAdditionalSources()
      ]);

      let allReports = [];
      
      if (donReports.status === 'fulfilled') {
        allReports = [...allReports, ...donReports.value];
      }
      
      if (additionalSources.status === 'fulfilled') {
        allReports = [...allReports, ...additionalSources.value];
      }

      // Deduplicate and sort by urgency/date
      const uniqueReports = this.deduplicateReports(allReports);
      uniqueReports.sort((a, b) => {
        // Sort by severity first, then by date
        if (a.severity !== b.severity) {
          const severityOrder = { 'CRITICAL': 3, 'HIGH': 2, 'MEDIUM': 1, 'LOW': 0 };
          return (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0);
        }
        return new Date(b.pubDate) - new Date(a.pubDate);
      });

      return this.sanitizeData({
        timestamp: new Date(),
        count: uniqueReports.length,
        outbreaks: uniqueReports.slice(0, 50),
        summary: this.generateSummary(uniqueReports),
        sources: {
          don: donReports.status === 'fulfilled' ? donReports.value.length : 0,
          additional: additionalSources.status === 'fulfilled' ? additionalSources.value.length : 0
        }
      });
    } catch (error) {
      console.error('[WHO] Error:', error.message);
      return this.sanitizeData({
        timestamp: new Date(),
        count: 0,
        outbreaks: [],
        error: error.message
      });
    }
  }

  async fetchDONReports() {
    try {
      const cached = this.cache.get('don');
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      console.log('[WHO] Fetching Disease Outbreak News...');
      
      // WHO Disease Outbreak News RSS Feed
      const feed = await this.parser.parseURL('https://www.who.int/feeds/entity/don/en/rss.xml');
      
      if (!feed.items) {
        return [];
      }

      const reports = await Promise.all(feed.items.map(async item => {
        const disease = this.extractDisease(item.title, item.contentSnippet || '');
        const location = this.extractLocation(item.title, item.contentSnippet || '');

        return {
          id: `who_don_${item.guid || item.link.slice(-20)}`,
          title: item.title,
          description: item.contentSnippet || item.content || '',
          url: item.link,
          pubDate: new Date(item.pubDate),
          source: 'WHO DON',
          disease: disease,
          location: location,
          severity: this.assessSeverity(item.title, item.contentSnippet || ''),
          category: this.categorizeOutbreak(disease),
          coordinates: await this.getCoordinates(location),
          riskLevel: this.calculateRiskLevel(disease, location)
        };
      }));

      this.cache.set('don', { data: reports, time: Date.now() });
      console.log(`[WHO] DON: ${reports.length} outbreak reports`);
      return reports;
    } catch (error) {
      console.error('[WHO] DON RSS error:', error.message);
      return [];
    }
  }

  async fetchAdditionalSources() {
    try {
      // Could add CDC, ECDC, or other health organization RSS feeds here
      // For now, return empty array
      return [];
    } catch (error) {
      console.error('[WHO] Additional sources error:', error.message);
      return [];
    }
  }

  extractDisease(title, content) {
    const diseaseKeywords = {
      'ebola': 'Ebola',
      'cholera': 'Cholera',
      'yellow fever': 'Yellow Fever',
      'mpox': 'Mpox',
      'monkeypox': 'Mpox',
      'marburg': 'Marburg',
      'lassa fever': 'Lassa Fever',
      'dengue': 'Dengue',
      'zika': 'Zika',
      'chikungunya': 'Chikungunya',
      'rift valley fever': 'Rift Valley Fever',
      'crimean-congo': 'Crimean-Congo Hemorrhagic Fever',
      'meningitis': 'Meningitis',
      'plague': 'Plague',
      'anthrax': 'Anthrax',
      'avian influenza': 'Avian Influenza',
      'h5n1': 'Avian Influenza (H5N1)',
      'measles': 'Measles',
      'polio': 'Poliomyelitis',
      'hepatitis': 'Hepatitis',
      'typhoid': 'Typhoid',
      'coronavirus': 'Coronavirus',
      'covid': 'COVID-19'
    };

    const text = `${title} ${content}`.toLowerCase();
    
    for (const [keyword, disease] of Object.entries(diseaseKeywords)) {
      if (text.includes(keyword)) {
        return disease;
      }
    }
    
    return 'Unknown Disease';
  }

  extractLocation(title, content) {
    // Simple regex to find country names (basic approach)
    const text = `${title} ${content}`;
    
    // Common country patterns in WHO reports
    const countryPatterns = [
      /in ([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/g,
      /([A-Z][a-z]+(?:\s[A-Z][a-z]+)*) reports?/g,
      /- ([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/g
    ];

    for (const pattern of countryPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const location = match[1];
        // Filter out obvious non-countries
        if (location && !['Disease', 'Outbreak', 'News', 'WHO', 'Update'].includes(location)) {
          return location;
        }
      }
    }
    
    return 'Unknown Location';
  }

  async getCoordinates(location) {
    // Simple mapping for major countries/regions
    const locationCoords = {
      'Democratic Republic of the Congo': { latitude: -4.0383, longitude: 21.7587 },
      'Nigeria': { latitude: 9.0820, longitude: 8.6753 },
      'Uganda': { latitude: 1.3733, longitude: 32.2903 },
      'Sudan': { latitude: 12.8628, longitude: 30.2176 },
      'Chad': { latitude: 15.4542, longitude: 18.7322 },
      'Guinea': { latitude: 9.9456, longitude: -9.6966 },
      'Liberia': { latitude: 6.4281, longitude: -9.4295 },
      'Sierra Leone': { latitude: 8.4606, longitude: -11.7799 },
      'Yemen': { latitude: 15.5527, longitude: 48.5164 },
      'Somalia': { latitude: 5.1521, longitude: 46.1996 },
      'Afghanistan': { latitude: 33.9391, longitude: 67.7100 },
      'Pakistan': { latitude: 30.3753, longitude: 69.3451 },
      'Bangladesh': { latitude: 23.6850, longitude: 90.3563 }
    };
    
    return locationCoords[location] || null;
  }

  assessSeverity(title, content) {
    const text = `${title} ${content}`.toLowerCase();
    
    if (text.includes('outbreak') && (text.includes('large') || text.includes('widespread') || text.includes('emergency'))) {
      return 'CRITICAL';
    }
    
    if (text.includes('outbreak') || text.includes('epidemic') || text.includes('cases reported')) {
      return 'HIGH';
    }
    
    if (text.includes('surveillance') || text.includes('monitoring') || text.includes('alert')) {
      return 'MEDIUM';
    }
    
    return 'LOW';
  }

  categorizeOutbreak(disease) {
    const categories = {
      'viral_hemorrhagic': ['Ebola', 'Marburg', 'Lassa Fever', 'Rift Valley Fever', 'Crimean-Congo Hemorrhagic Fever'],
      'vector_borne': ['Dengue', 'Zika', 'Chikungunya', 'Yellow Fever'],
      'respiratory': ['Avian Influenza', 'Avian Influenza (H5N1)', 'Coronavirus', 'COVID-19'],
      'gastrointestinal': ['Cholera', 'Typhoid', 'Hepatitis'],
      'vaccine_preventable': ['Measles', 'Poliomyelitis', 'Meningitis'],
      'zoonotic': ['Mpox', 'Plague', 'Anthrax'],
      'other': []
    };

    for (const [category, diseases] of Object.entries(categories)) {
      if (diseases.includes(disease)) {
        return category;
      }
    }
    
    return 'other';
  }

  calculateRiskLevel(disease, location) {
    // High-risk diseases
    const highRiskDiseases = ['Ebola', 'Marburg', 'Avian Influenza (H5N1)', 'Plague'];
    
    // High-risk regions (conflict zones, poor healthcare)
    const highRiskRegions = ['Democratic Republic of the Congo', 'Sudan', 'Yemen', 'Somalia', 'Afghanistan'];
    
    let score = 1;
    
    if (highRiskDiseases.includes(disease)) score += 2;
    if (highRiskRegions.includes(location)) score += 1;
    
    if (score >= 3) return 'CRITICAL';
    if (score >= 2) return 'HIGH';
    return 'MEDIUM';
  }

  deduplicateReports(reports) {
    const seen = new Map();
    
    for (const report of reports) {
      // Use disease + location as key
      const key = `${report.disease}_${report.location}`;
      
      if (!seen.has(key) || report.pubDate > seen.get(key).pubDate) {
        seen.set(key, report);
      }
    }
    
    return Array.from(seen.values());
  }

  generateSummary(reports) {
    const byDisease = {};
    const byLocation = {};
    const byCategory = {};
    const bySeverity = {};
    let criticalCount = 0;

    reports.forEach(report => {
      // By disease
      byDisease[report.disease] = (byDisease[report.disease] || 0) + 1;
      
      // By location
      byLocation[report.location] = (byLocation[report.location] || 0) + 1;
      
      // By category
      byCategory[report.category] = (byCategory[report.category] || 0) + 1;
      
      // By severity
      bySeverity[report.severity] = (bySeverity[report.severity] || 0) + 1;
      
      // Count critical
      if (report.severity === 'CRITICAL') {
        criticalCount++;
      }
    });

    return {
      total: reports.length,
      critical: criticalCount,
      byDisease: Object.entries(byDisease)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([disease, count]) => ({ disease, count })),
      byLocation: Object.entries(byLocation)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([location, count]) => ({ location, count })),
      byCategory,
      bySeverity,
      mostAffectedRegion: Object.entries(byLocation).sort((a, b) => b[1] - a[1])[0],
      dominantDisease: Object.entries(byDisease).sort((a, b) => b[1] - a[1])[0]
    };
  }

  getDefaultState() {
    return {
      timestamp: null,
      count: 0,
      outbreaks: [],
      summary: {
        total: 0,
        critical: 0,
        byDisease: [],
        byLocation: [],
        byCategory: {},
        bySeverity: {},
        mostAffectedRegion: null,
        dominantDisease: null
      }
    };
  }

  getAlerts(data) {
    const alerts = [];
    
    // Alert on critical outbreaks
    if (data.outbreaks) {
      const criticalOutbreaks = data.outbreaks.filter(o => o.severity === 'CRITICAL');
      if (criticalOutbreaks.length > 0) {
        alerts.push({
          id: `who_critical_${Date.now()}`,
          type: 'DISEASE_OUTBREAK',
          severity: 'CRITICAL',
          message: `${criticalOutbreaks.length} critical disease outbreak(s) reported by WHO`,
          timestamp: new Date(),
          data: { 
            criticalCount: criticalOutbreaks.length,
            diseases: criticalOutbreaks.map(o => o.disease)
          }
        });
      }

      // Alert on high-risk diseases
      const highRiskDiseases = data.outbreaks.filter(o => 
        ['Ebola', 'Marburg', 'Avian Influenza (H5N1)'].includes(o.disease)
      );
      if (highRiskDiseases.length > 0) {
        alerts.push({
          id: `who_high_risk_${Date.now()}`,
          type: 'DISEASE_OUTBREAK',
          severity: 'HIGH',
          message: `High-risk disease outbreak detected: ${highRiskDiseases[0].disease} in ${highRiskDiseases[0].location}`,
          timestamp: new Date(),
          data: { outbreak: highRiskDiseases[0] }
        });
      }
    }
    
    return alerts;
  }
}

module.exports = new WhoOutbreaksModule();
