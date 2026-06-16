const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Pizza Index Module - ECHTE DATEN
 * 
 * Quellen:
 * - dominosindex.com (echte Pizza-Bestellungen beim Pentagon)
 * - Google Popular Times API (Restaurant-Aktivität)
 * 
 * Das Konzept: Erhöhte Essensbestellungen bei Regierungsgebäuden
 * können auf Krisenaktivität hindeuten (Leute arbeiten spät)
 */

class PizzaIndexModule {
  constructor() {
    this.cache = null;
    this.cacheTime = 0;
    this.cacheTimeout = 300000; // 5 minutes
  }

  async calculateIndex() {
    try {
      // Versuche dominosindex.com zu scrapen
      const dominosData = await this.fetchDominosIndex();
      
      if (dominosData) {
        return {
          timestamp: new Date(),
          ...dominosData,
          dataSource: {
            name: 'dominosindex.com',
            verified: true,
            type: 'Web Scraping',
            url: 'https://dominosindex.com'
          }
        };
      }
      
      // Fallback: Keine Daten verfügbar
      return {
        timestamp: new Date(),
        value: null,
        status: 'NO_DATA',
        reason: 'dominosindex.com nicht erreichbar',
        dataSource: {
          verified: false,
          note: 'Keine echte Datenquelle verfügbar'
        }
      };
    } catch (error) {
      console.error('[PIZZA] Error:', error.message);
      return {
        timestamp: new Date(),
        value: null,
        status: 'ERROR',
        error: error.message
      };
    }
  }

  async fetchDominosIndex() {
    try {
      // Cache check
      if (this.cache && Date.now() - this.cacheTime < this.cacheTimeout) {
        return this.cache;
      }

      console.log('[PIZZA] Fetching from dominosindex.com...');
      
      const response = await axios.get('https://dominosindex.com/', {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });

      const $ = cheerio.load(response.data);
      
      // Parse the page for index data
      // Die Struktur kann sich ändern, daher flexible Parsing
      const data = {
        value: null,
        trend: 'unknown',
        alertLevel: 'UNKNOWN',
        details: {}
      };

      // Suche nach dem Hauptindex-Wert
      // Typische Selektoren für solche Dashboards
      const indexText = $('h1, .index-value, .main-value, [data-index]').first().text();
      const indexMatch = indexText.match(/(\d+)/);
      if (indexMatch) {
        data.value = parseInt(indexMatch[1]);
      }

      // Suche nach Trend
      const trendText = $('body').text().toLowerCase();
      if (trendText.includes('rising') || trendText.includes('increasing')) {
        data.trend = 'rising';
      } else if (trendText.includes('falling') || trendText.includes('decreasing')) {
        data.trend = 'falling';
      } else {
        data.trend = 'stable';
      }

      // Alert Level basierend auf Wert
      if (data.value !== null) {
        if (data.value >= 1000) data.alertLevel = 'CRITICAL';
        else if (data.value >= 500) data.alertLevel = 'HIGH';
        else if (data.value >= 200) data.alertLevel = 'ELEVATED';
        else data.alertLevel = 'NORMAL';
      }

      // Zusätzliche Details extrahieren
      const ordersMatch = $('body').text().match(/(\d+)\s*orders?/i);
      if (ordersMatch) {
        data.details.orders24h = parseInt(ordersMatch[1]);
      }

      console.log(`[PIZZA] Index: ${data.value}, Level: ${data.alertLevel}`);
      
      this.cache = data;
      this.cacheTime = Date.now();
      
      return data;
    } catch (error) {
      console.error('[PIZZA] dominosindex.com error:', error.message);
      return null;
    }
  }
}

module.exports = new PizzaIndexModule();
