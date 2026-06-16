const axios = require('axios');

/**
 * Weather Monitor Module
 * 
 * Monitors global weather conditions
 * Useful for: Military operations weather windows, storm tracking
 * 
 * FREE Data Sources:
 * - Open-Meteo (no API key required!)
 * - OpenWeatherMap (free tier)
 */

// Strategic locations to monitor weather
const STRATEGIC_LOCATIONS = {
  // Middle East
  tehran: { name: 'Tehran, Iran', lat: 35.6892, lon: 51.389, priority: 'CRITICAL' },
  baghdad: { name: 'Baghdad, Iraq', lat: 33.3152, lon: 44.3661, priority: 'HIGH' },
  damascus: { name: 'Damascus, Syria', lat: 33.5138, lon: 36.2765, priority: 'HIGH' },
  riyadh: { name: 'Riyadh, Saudi Arabia', lat: 24.7136, lon: 46.6753, priority: 'MEDIUM' },
  
  // Europe/NATO
  ramstein: { name: 'Ramstein AB, Germany', lat: 49.4369, lon: 7.6003, priority: 'HIGH' },
  fairford: { name: 'RAF Fairford, UK', lat: 51.682, lon: -1.79, priority: 'HIGH' },
  moron: { name: 'Morón AB, Spain', lat: 37.175, lon: -5.616, priority: 'HIGH' },
  
  // Americas
  caracas: { name: 'Caracas, Venezuela', lat: 10.4806, lon: -66.9036, priority: 'HIGH' },
  bogota: { name: 'Bogotá, Colombia', lat: 4.711, lon: -74.0721, priority: 'MEDIUM' },
  
  // Arctic
  thule: { name: 'Thule AB, Greenland', lat: 76.5312, lon: -68.7031, priority: 'HIGH' },
  nuuk: { name: 'Nuuk, Greenland', lat: 64.1814, lon: -51.6941, priority: 'MEDIUM' },
  
  // Pacific
  guam: { name: 'Andersen AFB, Guam', lat: 13.584, lon: 144.924, priority: 'HIGH' },
  diegoGarcia: { name: 'Diego Garcia', lat: -7.3195, lon: 72.4229, priority: 'CRITICAL' },
  
  // Russia
  moscow: { name: 'Moscow, Russia', lat: 55.7558, lon: 37.6173, priority: 'HIGH' },
  kaliningrad: { name: 'Kaliningrad, Russia', lat: 54.7104, lon: 20.4522, priority: 'HIGH' }
};

class WeatherMonitor {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 600000; // 10 minutes
  }

  async monitorWeather() {
    try {
      const weatherData = await this.fetchAllLocations();
      
      return {
        timestamp: new Date(),
        locations: weatherData,
        summary: this.generateSummary(weatherData),
        operationalWindows: this.analyzeOperationalWindows(weatherData)
      };
    } catch (error) {
      console.error('[WEATHER] Error:', error.message);
      return {
        timestamp: new Date(),
        locations: [],
        summary: {},
        error: error.message
      };
    }
  }

  async fetchAllLocations() {
    const results = [];
    
    // Batch locations for efficiency
    const locations = Object.entries(STRATEGIC_LOCATIONS);
    
    for (const [key, loc] of locations) {
      try {
        const weather = await this.fetchOpenMeteo(loc);
        if (weather) {
          results.push({
            id: key,
            ...loc,
            weather
          });
        }
      } catch (e) {
        console.error(`[WEATHER] Error fetching ${loc.name}:`, e.message);
      }
      
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 100));
    }
    
    console.log(`[WEATHER] Fetched ${results.length} locations`);
    return results;
  }

  async fetchOpenMeteo(location) {
    try {
      const cacheKey = `weather_${location.lat}_${location.lon}`;
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.time < this.cacheTimeout) {
        return cached.data;
      }

      // Open-Meteo API - completely FREE, no API key!
      const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
        params: {
          latitude: location.lat,
          longitude: location.lon,
          current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility',
          hourly: 'temperature_2m,precipitation_probability,weather_code,visibility,wind_speed_10m',
          daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max',
          timezone: 'auto',
          forecast_days: 3
        },
        timeout: 10000
      });

      const data = response.data;
      
      const weather = {
        current: {
          temperature: data.current?.temperature_2m,
          humidity: data.current?.relative_humidity_2m,
          feelsLike: data.current?.apparent_temperature,
          precipitation: data.current?.precipitation,
          weatherCode: data.current?.weather_code,
          weatherDescription: this.getWeatherDescription(data.current?.weather_code),
          cloudCover: data.current?.cloud_cover,
          windSpeed: data.current?.wind_speed_10m,
          windDirection: data.current?.wind_direction_10m,
          windGusts: data.current?.wind_gusts_10m,
          visibility: data.current?.visibility
        },
        forecast: {
          hourly: data.hourly?.time?.slice(0, 24).map((time, i) => ({
            time: new Date(time),
            temperature: data.hourly.temperature_2m[i],
            precipitationProbability: data.hourly.precipitation_probability[i],
            weatherCode: data.hourly.weather_code[i],
            visibility: data.hourly.visibility[i],
            windSpeed: data.hourly.wind_speed_10m[i]
          })),
          daily: data.daily?.time?.map((time, i) => ({
            date: time,
            weatherCode: data.daily.weather_code[i],
            tempMax: data.daily.temperature_2m_max[i],
            tempMin: data.daily.temperature_2m_min[i],
            precipitation: data.daily.precipitation_sum[i],
            windSpeedMax: data.daily.wind_speed_10m_max[i]
          }))
        },
        timestamp: new Date()
      };

      this.cache.set(cacheKey, { data: weather, time: Date.now() });
      return weather;
    } catch (error) {
      console.error(`[WEATHER] Open-Meteo error for ${location.name}:`, error.message);
      return null;
    }
  }

  getWeatherDescription(code) {
    const descriptions = {
      0: 'Clear sky',
      1: 'Mainly clear',
      2: 'Partly cloudy',
      3: 'Overcast',
      45: 'Fog',
      48: 'Depositing rime fog',
      51: 'Light drizzle',
      53: 'Moderate drizzle',
      55: 'Dense drizzle',
      61: 'Slight rain',
      63: 'Moderate rain',
      65: 'Heavy rain',
      71: 'Slight snow',
      73: 'Moderate snow',
      75: 'Heavy snow',
      77: 'Snow grains',
      80: 'Slight rain showers',
      81: 'Moderate rain showers',
      82: 'Violent rain showers',
      85: 'Slight snow showers',
      86: 'Heavy snow showers',
      95: 'Thunderstorm',
      96: 'Thunderstorm with slight hail',
      99: 'Thunderstorm with heavy hail'
    };
    return descriptions[code] || 'Unknown';
  }

  generateSummary(locations) {
    if (locations.length === 0) return {};

    const summary = {
      total: locations.length,
      byPriority: {
        CRITICAL: locations.filter(l => l.priority === 'CRITICAL').length,
        HIGH: locations.filter(l => l.priority === 'HIGH').length,
        MEDIUM: locations.filter(l => l.priority === 'MEDIUM').length
      },
      conditions: {
        clear: 0,
        cloudy: 0,
        precipitation: 0,
        severe: 0
      }
    };

    for (const loc of locations) {
      const code = loc.weather?.current?.weatherCode;
      if (code === 0 || code === 1) summary.conditions.clear++;
      else if (code >= 2 && code <= 3) summary.conditions.cloudy++;
      else if (code >= 51 && code <= 86) summary.conditions.precipitation++;
      else if (code >= 95) summary.conditions.severe++;
    }

    return summary;
  }

  analyzeOperationalWindows(locations) {
    const windows = [];

    for (const loc of locations) {
      if (!loc.weather?.forecast?.hourly) continue;

      // Find good weather windows (clear, good visibility, low wind)
      let windowStart = null;
      let currentWindow = null;

      for (const hour of loc.weather.forecast.hourly) {
        const isGood = (
          hour.visibility > 10000 &&
          hour.windSpeed < 30 &&
          hour.precipitationProbability < 20 &&
          [0, 1, 2].includes(hour.weatherCode)
        );

        if (isGood && !windowStart) {
          windowStart = hour.time;
          currentWindow = { start: hour.time, location: loc.name, priority: loc.priority };
        } else if (!isGood && windowStart) {
          currentWindow.end = hour.time;
          currentWindow.duration = (hour.time - windowStart) / 3600000; // hours
          if (currentWindow.duration >= 2) { // At least 2 hour window
            windows.push(currentWindow);
          }
          windowStart = null;
          currentWindow = null;
        }
      }
    }

    return windows.sort((a, b) => {
      const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }
}

module.exports = new WeatherMonitor();

