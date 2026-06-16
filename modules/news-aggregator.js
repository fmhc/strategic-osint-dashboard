const Parser = require('rss-parser');
const axios = require('axios');

/**
 * News Aggregator Module - ERWEITERT MIT SOCIAL MEDIA
 * 
 * ECHTE Quellen:
 * - RSS Feeds von Nachrichtenagenturen
 * - Reddit (r/worldnews, r/geopolitics, r/military)
 * - GDELT Project
 * - YouTube News Channels
 */

class NewsAggregator {
  constructor() {
    this.parser = new Parser({
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)'
      }
    });
    
    // ALLE News-Quellen
    this.feeds = [
      // === MAINSTREAM NEWS ===
      { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'news', icon: '📺' },
      { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'news', icon: '📺' },
      { name: 'DW News', url: 'https://rss.dw.com/xml/rss-en-all', category: 'news', icon: '📺' },
      { name: 'NPR World', url: 'https://feeds.npr.org/1004/rss.xml', category: 'news', icon: '📻' },
      { name: 'France24', url: 'https://www.france24.com/en/rss', category: 'news', icon: '📺' },
      { name: 'Reuters World', url: 'https://www.reutersagency.com/feed/?taxonomy=best-sectors&post_type=best', category: 'news', icon: '📰' },
      { name: 'AP News', url: 'https://rsshub.app/apnews/topics/world-news', category: 'news', icon: '📰' },
      
      // === DEFENSE & MILITARY ===
      { name: 'Defense News', url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml', category: 'defense', icon: '🎖️' },
      { name: 'Breaking Defense', url: 'https://breakingdefense.com/feed/', category: 'defense', icon: '🎖️' },
      { name: 'Military Times', url: 'https://www.militarytimes.com/arc/outboundfeeds/rss/?outputType=xml', category: 'defense', icon: '🎖️' },
      { name: 'War on the Rocks', url: 'https://warontherocks.com/feed/', category: 'defense', icon: '🎖️' },
      { name: 'The War Zone', url: 'https://www.thedrive.com/the-war-zone/feed', category: 'defense', icon: '✈️' },
      { name: 'Navy Times', url: 'https://www.navytimes.com/arc/outboundfeeds/rss/?outputType=xml', category: 'defense', icon: '⚓' },
      
      // === GEOPOLITICS ===
      { name: 'Foreign Policy', url: 'https://foreignpolicy.com/feed/', category: 'geopolitics', icon: '🌐' },
      { name: 'Foreign Affairs', url: 'https://www.foreignaffairs.com/rss.xml', category: 'geopolitics', icon: '🌐' },
      { name: 'The Diplomat', url: 'https://thediplomat.com/feed/', category: 'geopolitics', icon: '🌏' },
      { name: 'CSIS', url: 'https://www.csis.org/analysis/feed', category: 'geopolitics', icon: '🏛️' },
      
      // === CYBER SECURITY ===
      { name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews', category: 'cyber', icon: '💻' },
      { name: 'Krebs on Security', url: 'https://krebsonsecurity.com/feed/', category: 'cyber', icon: '🔒' },
      { name: 'Dark Reading', url: 'https://www.darkreading.com/rss.xml', category: 'cyber', icon: '🔒' },
      { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', category: 'tech', icon: '💻' },
      
      // === REDDIT - SOCIAL MEDIA ===
      { name: 'Reddit WorldNews', url: 'https://www.reddit.com/r/worldnews/top/.rss?t=day', category: 'social', icon: '🔴', platform: 'reddit' },
      { name: 'Reddit Geopolitics', url: 'https://www.reddit.com/r/geopolitics/hot/.rss', category: 'social', icon: '🔴', platform: 'reddit' },
      { name: 'Reddit Military', url: 'https://www.reddit.com/r/Military/hot/.rss', category: 'social', icon: '🔴', platform: 'reddit' },
      { name: 'Reddit CombatFootage', url: 'https://www.reddit.com/r/CombatFootage/hot/.rss', category: 'social', icon: '🔴', platform: 'reddit' },
      { name: 'Reddit Ukraine', url: 'https://www.reddit.com/r/ukraine/hot/.rss', category: 'social', icon: '🔴', platform: 'reddit' },
      { name: 'Reddit OSINT', url: 'https://www.reddit.com/r/OSINT/hot/.rss', category: 'social', icon: '🔴', platform: 'reddit' },
      
      // === YOUTUBE NEWS (via RSSHub) ===
      { name: 'CNN Live', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCupvZG-5ko_eiXAupbDfxWw', category: 'video', icon: '▶️', platform: 'youtube' },
      { name: 'Sky News', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCoMdktPbSTixAyNGwb-UYkQ', category: 'video', icon: '▶️', platform: 'youtube' },
      { name: 'DW News YT', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCknLrEdhRCp1aegoMqRaCZg', category: 'video', icon: '▶️', platform: 'youtube' },
      { name: 'Al Jazeera YT', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCNye-wNBqNL5ZzHSJj3l8Bg', category: 'video', icon: '▶️', platform: 'youtube' },
      
      // === LIVE BLOGS & WIRES ===
      { name: 'Liveuamap', url: 'https://liveuamap.com/rss', category: 'live', icon: '🔴' },
    ];

    // Keywords für Relevanz
    this.keywords = {
      critical: ['nuclear', 'invasion', 'war declared', 'missile strike', 'troops deployed', 'defcon', 'attack', 'blockade'],
      high: ['military', 'strike', 'missile', 'bombing', 'troops', 'pentagon', 'nato', 'mobilization', 'drill', 'exercise'],
      medium: ['defense', 'army', 'navy', 'airforce', 'drone', 'weapon', 'sanctions', 'conflict', 'tension'],
      locations: ['iran', 'venezuela', 'russia', 'china', 'ukraine', 'israel', 'gaza', 'syria', 'korea', 'taiwan', 'greenland', 'arctic', 'baltic', 'mediterranean']
    };
  }

  async aggregateNews() {
    const articles = [];
    const errors = [];
    const successfulFeeds = [];

    // Fetch all feeds in parallel
    const feedPromises = this.feeds.map(feed => this.fetchFeed(feed));
    const results = await Promise.allSettled(feedPromises);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const feed = this.feeds[i];

      if (result.status === 'fulfilled' && result.value.length > 0) {
        articles.push(...result.value);
        successfulFeeds.push(feed.name);
      } else {
        errors.push({ feed: feed.name, error: result.reason?.message || 'No articles' });
      }
    }

    // Also try GDELT
    try {
      const gdeltArticles = await this.fetchGDELT();
      articles.push(...gdeltArticles);
      if (gdeltArticles.length > 0) successfulFeeds.push('GDELT');
    } catch (e) {
      console.log('[NEWS] GDELT error:', e.message);
    }

    // Sort by relevance and date
    articles.sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      return new Date(b.pubDate) - new Date(a.pubDate);
    });

    // Deduplicate by title similarity
    const uniqueArticles = this.deduplicateArticles(articles);

    const result = {
      timestamp: new Date(),
      count: uniqueArticles.length,
      articles: uniqueArticles.slice(0, 150),
      summary: {
        totalFeeds: this.feeds.length,
        successfulFeeds: successfulFeeds.length,
        feedNames: successfulFeeds,
        byCategory: this.countByCategory(uniqueArticles),
        topKeywords: this.extractTopKeywords(uniqueArticles),
        criticalCount: uniqueArticles.filter(a => a.relevance >= 8).length
      },
      dataSource: {
        type: 'RSS + Social Media + GDELT',
        verified: true,
        sources: successfulFeeds.slice(0, 20)
      }
    };

    console.log(`[NEWS] ${uniqueArticles.length} articles from ${successfulFeeds.length}/${this.feeds.length} feeds`);
    return result;
  }

  async fetchFeed(feed) {
    try {
      const feedData = await this.parser.parseURL(feed.url);
      const articles = [];

      for (const item of feedData.items.slice(0, 20)) {
        const relevance = this.calculateRelevance(item.title, item.contentSnippet || '');
        
        // Include all from social media, filter others
        if (relevance > 0 || feed.category === 'social' || feed.category === 'video') {
          articles.push({
            source: feed.name,
            icon: feed.icon || '📰',
            category: feed.category,
            platform: feed.platform || 'web',
            title: this.cleanTitle(item.title),
            link: item.link,
            pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
            relevance: Math.max(relevance, feed.category === 'social' ? 3 : 1),
            snippet: (item.contentSnippet || '').substring(0, 200),
            isVideo: feed.platform === 'youtube',
            isReddit: feed.platform === 'reddit',
            verified: true
          });
        }
      }

      if (articles.length > 0) {
        console.log(`[NEWS] ${feed.name}: ${articles.length} items`);
      }
      return articles;
    } catch (error) {
      // Silent fail for most feeds
      return [];
    }
  }

  async fetchGDELT() {
    try {
      const response = await axios.get('https://api.gdeltproject.org/api/v2/doc/doc', {
        params: {
          query: '(military OR conflict OR attack OR troops OR missile) (Iran OR Taiwan OR China OR Russia OR Ukraine)',
          mode: 'artlist',
          maxrecords: 30,
          format: 'json',
          sort: 'datedesc'
        },
        timeout: 15000
      });

      if (response.data && response.data.articles) {
        return response.data.articles.map(article => ({
          source: 'GDELT: ' + (article.domain || 'Unknown'),
          icon: '🌐',
          category: 'gdelt',
          platform: 'gdelt',
          title: article.title,
          link: article.url,
          pubDate: article.seendate ? new Date(article.seendate) : new Date(),
          relevance: 6,
          snippet: article.title,
          verified: true
        }));
      }
    } catch (error) {
      // Silent fail
    }
    return [];
  }

  cleanTitle(title) {
    if (!title) return '';
    // Remove Reddit prefixes, clean up
    return title
      .replace(/^\[.*?\]\s*/, '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }

  calculateRelevance(title, content) {
    const text = `${title} ${content}`.toLowerCase();
    let score = 0;

    for (const keyword of this.keywords.critical) {
      if (text.includes(keyword)) score += 5;
    }
    for (const keyword of this.keywords.high) {
      if (text.includes(keyword)) score += 3;
    }
    for (const keyword of this.keywords.medium) {
      if (text.includes(keyword)) score += 2;
    }
    for (const location of this.keywords.locations) {
      if (text.includes(location)) score += 2;
    }

    return Math.min(score, 10);
  }

  deduplicateArticles(articles) {
    const seen = new Map();
    const unique = [];

    for (const article of articles) {
      // Create a simplified key from title
      const key = article.title.toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .substring(0, 50);
      
      if (!seen.has(key)) {
        seen.set(key, true);
        unique.push(article);
      }
    }

    return unique;
  }

  countByCategory(articles) {
    const counts = {};
    for (const article of articles) {
      counts[article.category] = (counts[article.category] || 0) + 1;
    }
    return counts;
  }

  extractTopKeywords(articles) {
    const counts = {};
    const allKeywords = [
      ...this.keywords.critical,
      ...this.keywords.high,
      ...this.keywords.medium,
      ...this.keywords.locations
    ];
    
    for (const article of articles) {
      const text = `${article.title} ${article.snippet}`.toLowerCase();
      for (const kw of allKeywords) {
        if (text.includes(kw)) {
          counts[kw] = (counts[kw] || 0) + 1;
        }
      }
    }

    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .reduce((obj, [k, v]) => ({ ...obj, [k]: v }), {});
  }
}

module.exports = new NewsAggregator();
