const axios = require('axios');
const fs = require('fs');
const path = require('path');
const llm = require('./llm-client');

/**
 * Ollama AI Analyst Module
 * 
 * Uses local Ollama LLM to:
 * - Analyze current geopolitical situation
 * - Generate intelligence assessments
 * - Create task lists for additional research
 * - Predict potential developments
 */

// SQLite setup (simple file-based for portability)
let db = null;
const DB_PATH = path.join(__dirname, '..', 'data', 'osint.db');

class OllamaAnalyst {
  constructor() {
    this.ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    this.model = process.env.OLLAMA_MODEL || 'llama3:8b';
    this.lastAnalysis = null;
    this.analysisInterval = 15 * 60 * 1000; // 15 minutes
    this.initDatabase();
  }

  initDatabase() {
    try {
      // Create data directory if it doesn't exist
      const dataDir = path.dirname(DB_PATH);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Use simple JSON file as database (works without native modules)
      this.dbPath = path.join(dataDir, 'analysis.json');
      
      if (!fs.existsSync(this.dbPath)) {
        this.saveDatabase({
          analyses: [],
          tasks: [],
          predictions: []
        });
      }
      
      console.log('[OLLAMA] Database initialized at', this.dbPath);
    } catch (error) {
      console.error('[OLLAMA] Database init error:', error.message);
    }
  }

  loadDatabase() {
    try {
      if (fs.existsSync(this.dbPath)) {
        return JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
      }
    } catch (e) {
      console.error('[OLLAMA] Error loading database:', e.message);
    }
    return { analyses: [], tasks: [], predictions: [] };
  }

  saveDatabase(data) {
    try {
      fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[OLLAMA] Error saving database:', e.message);
    }
  }

  async analyzeCurrentSituation(globalState) {
    try {
      // Check if Ollama is available
      const isAvailable = await this.checkOllamaAvailable();
      if (!isAvailable) {
        console.log('[OLLAMA] Ollama not available, skipping analysis');
        return this.getLastAnalysis();
      }

      // Prepare situation summary
      const situationSummary = this.prepareSituationSummary(globalState);
      
      // Generate analysis prompt
      const prompt = this.generateAnalysisPrompt(situationSummary);
      
      // Call Ollama
      const analysis = await this.callOllama(prompt);
      
      if (analysis) {
        // Parse and structure the analysis
        const structuredAnalysis = this.parseAnalysis(analysis);
        
        // Save to database
        this.saveAnalysis(structuredAnalysis, situationSummary);
        
        // Extract and save tasks
        if (structuredAnalysis.tasks && structuredAnalysis.tasks.length > 0) {
          this.saveTasks(structuredAnalysis.tasks);
        }
        
        this.lastAnalysis = {
          timestamp: new Date(),
          ...structuredAnalysis,
          raw: analysis
        };
        
        return this.lastAnalysis;
      }
    } catch (error) {
      console.error('[OLLAMA] Analysis error:', error.message);
    }
    
    return this.getLastAnalysis();
  }

  /**
   * Loader entry point. The module-loader calls update() with no args, so we
   * pull the live global state from our own /api/state endpoint and run a full
   * situation assessment. The returned object (aiAnalysis shape) is stored by
   * the loader into globalState.aiAnalysis and broadcast as 'ai-analysis-update',
   * which is what feeds the front-end "AI ANALYSIS" panel.
   */
  async update() {
    try {
      const port = process.env.PORT || 3333;
      const resp = await axios.get(`http://127.0.0.1:${port}/api/state`, { timeout: 8000 });
      return await this.analyzeCurrentSituation(resp.data || {});
    } catch (error) {
      console.error('[OLLAMA] update() error:', error.message);
      return this.getLastAnalysis();
    }
  }

  async checkOllamaAvailable() {
    return llm.isAvailable(5000);
  }

  prepareSituationSummary(state) {
    const summary = {
      timestamp: new Date().toISOString(),
      pizzaIndex: {
        value: state.pizzaIndex?.value || 0,
        alertLevel: state.pizzaIndex?.alertLevel || 'UNKNOWN',
        trend: state.pizzaIndex?.trend || 'stable'
      },
      flights: {
        total: state.flights?.count || state.flights?.flights?.length || 0,
        byCategory: state.flights?.summary?.byCategory || {},
        byThreatLevel: state.flights?.summary?.byThreatLevel || {},
        specialCallsigns: state.flights?.summary?.specialCallsigns || []
      },
      signals: {
        eamCount: state.signals?.eams?.length || 0,
        gpsJammingZones: state.signals?.gpsJamming?.length || 0,
        gpsLocations: state.signals?.gpsJamming?.map(z => z.location) || [],
        radioSilence: state.signals?.radioSilence?.length || 0,
        threatLevel: state.signals?.summary?.threatLevel || 'UNKNOWN'
      },
      seismic: {
        eventCount: state.seismic?.count || 0,
        maxMagnitude: state.seismic?.summary?.maxMagnitude || 0,
        possibleManMade: state.seismic?.summary?.possibleManMade || 0,
        nearSensitiveSites: state.seismic?.summary?.nearSensitiveSites || 0
      },
      spaceWeather: {
        kpIndex: state.spaceWeather?.current?.kpIndex || 0,
        gLevel: state.spaceWeather?.current?.gLevel || 'G0',
        solarFlares: state.spaceWeather?.solarFlares?.length || 0,
        cmes: state.spaceWeather?.cme?.length || 0
      },
      internet: {
        outages: state.internet?.outages?.length || 0,
        criticalCountries: state.internet?.monitoredCountries || {}
      },
      alerts: {
        total: state.alerts?.length || 0,
        critical: state.alerts?.filter(a => a.severity === 'CRITICAL')?.length || 0,
        recent: state.alerts?.slice(0, 5)?.map(a => ({
          source: a.source,
          severity: a.severity,
          message: a.message
        })) || []
      },
      news: {
        count: state.news?.count || state.news?.articles?.length || 0,
        topKeywords: state.news?.summary?.topKeywords || {}
      }
    };
    
    return summary;
  }

  generateAnalysisPrompt(situation) {
    return `You are a military intelligence analyst. Analyze the following OSINT data and provide:

1. **SITUATION ASSESSMENT**: Current threat level and key observations
2. **KEY INDICATORS**: Most significant indicators in the data
3. **PROBABLE DEVELOPMENTS**: What might happen in the next 24-48 hours
4. **INFORMATION GAPS**: What additional intelligence do we need?
5. **RECOMMENDED ACTIONS**: Priority monitoring tasks

Current OSINT Data (${situation.timestamp}):

PIZZA INDEX (Pentagon Activity): ${situation.pizzaIndex.value}% (${situation.pizzaIndex.alertLevel}, trend: ${situation.pizzaIndex.trend})

STRATEGIC FLIGHTS:
- Total tracked: ${situation.flights.total}
- Categories: ${JSON.stringify(situation.flights.byCategory)}
- Threat levels: ${JSON.stringify(situation.flights.byThreatLevel)}
- Special callsigns: ${situation.flights.specialCallsigns.join(', ') || 'None detected'}

SIGNALS INTELLIGENCE:
- Emergency Action Messages: ${situation.signals.eamCount}
- GPS Jamming Zones: ${situation.signals.gpsJammingZones} (${situation.signals.gpsLocations.join(', ') || 'None'})
- Units in Radio Silence: ${situation.signals.radioSilence}
- Overall Threat Level: ${situation.signals.threatLevel}

SEISMIC ACTIVITY:
- Events (24h): ${situation.seismic.eventCount}
- Max magnitude: ${situation.seismic.maxMagnitude}
- Possible man-made events: ${situation.seismic.possibleManMade}
- Near sensitive sites: ${situation.seismic.nearSensitiveSites}

SPACE WEATHER:
- Kp Index: ${situation.spaceWeather.kpIndex} (${situation.spaceWeather.gLevel})
- Solar flares (7d): ${situation.spaceWeather.solarFlares}
- CMEs (7d): ${situation.spaceWeather.cmes}

CYBER/INTERNET:
- Active outages: ${situation.internet.outages}

ACTIVE ALERTS: ${situation.alerts.total} (${situation.alerts.critical} critical)
${situation.alerts.recent.map(a => `- [${a.severity}] ${a.source}: ${a.message}`).join('\n')}

Respond with ONLY a single valid JSON object (no markdown, no prose) of this exact shape:
{
  "threatLevel": "NORMAL|ELEVATED|HIGH|CRITICAL",
  "situationAssessment": "2-4 sentence assessment of the current situation",
  "keyIndicators": ["..."],
  "probableDevelopments": ["...24-48h outlook..."],
  "informationGaps": ["..."],
  "recommendedActions": ["...priority monitoring tasks..."]
}
Be specific and actionable.`;
  }

  async callOllama(prompt) {
    try {
      console.log(`[OLLAMA] Calling LLM for analysis (${llm.describe()})...`);

      const text = await llm.complete(
        {
          system: 'You are a senior OSINT geopolitical intelligence analyst. Output ONLY valid JSON, no prose, no markdown.',
          user: prompt,
        },
        { maxTokens: 1200, temperature: 0.5, timeout: 300000, json: true }
      );

      if (text) {
        console.log('[OLLAMA] Analysis complete');
        return text;
      }
    } catch (error) {
      console.error('[OLLAMA] API error:', error.message);
    }
    return null;
  }

  parseAnalysis(rawAnalysis) {
    const analysis = {
      situationAssessment: '',
      keyIndicators: [],
      probableDevelopments: [],
      informationGaps: [],
      tasks: [],
      threatLevel: 'UNKNOWN',
      confidence: 'MEDIUM'
    };

    // JSON-first: modern models return a clean JSON object.
    try {
      const jsonStr = rawAnalysis.slice(rawAnalysis.indexOf('{'), rawAnalysis.lastIndexOf('}') + 1);
      if (jsonStr) {
        const j = JSON.parse(jsonStr);
        const lvl = String(j.threatLevel || '').toUpperCase();
        analysis.threatLevel = ['NORMAL', 'ELEVATED', 'HIGH', 'CRITICAL'].includes(lvl) ? lvl : 'UNKNOWN';
        analysis.situationAssessment = j.situationAssessment || '';
        analysis.keyIndicators = Array.isArray(j.keyIndicators) ? j.keyIndicators : [];
        analysis.probableDevelopments = Array.isArray(j.probableDevelopments) ? j.probableDevelopments : [];
        analysis.informationGaps = Array.isArray(j.informationGaps) ? j.informationGaps : [];
        const acts = Array.isArray(j.recommendedActions) ? j.recommendedActions : [];
        analysis.tasks = acts.map((item, i) => ({
          id: `task_${Date.now()}_${i}`,
          description: typeof item === 'string' ? item : (item.description || JSON.stringify(item)),
          priority: i < 3 ? 'HIGH' : 'MEDIUM',
          status: 'pending',
          createdAt: new Date().toISOString()
        }));
        if (analysis.situationAssessment) return analysis;
      }
    } catch (e) {
      // not JSON — fall through to legacy regex parsing
    }

    try {
      // Extract sections using regex
      const sections = {
        assessment: /SITUATION ASSESSMENT[:\s]*([^#*]+?)(?=KEY INDICATORS|PROBABLE|INFORMATION|RECOMMENDED|$)/is,
        indicators: /KEY INDICATORS[:\s]*([^#]+?)(?=PROBABLE|INFORMATION|RECOMMENDED|$)/is,
        developments: /PROBABLE DEVELOPMENTS[:\s]*([^#]+?)(?=INFORMATION|RECOMMENDED|$)/is,
        gaps: /INFORMATION GAPS[:\s]*([^#]+?)(?=RECOMMENDED|$)/is,
        actions: /RECOMMENDED ACTIONS[:\s]*([^#]+?)$/is
      };

      const assessmentMatch = rawAnalysis.match(sections.assessment);
      if (assessmentMatch) {
        analysis.situationAssessment = assessmentMatch[1].trim();
        
        // Try to extract threat level from assessment
        if (rawAnalysis.toLowerCase().includes('critical')) analysis.threatLevel = 'CRITICAL';
        else if (rawAnalysis.toLowerCase().includes('high')) analysis.threatLevel = 'HIGH';
        else if (rawAnalysis.toLowerCase().includes('elevated')) analysis.threatLevel = 'ELEVATED';
        else if (rawAnalysis.toLowerCase().includes('normal')) analysis.threatLevel = 'NORMAL';
      }

      const indicatorsMatch = rawAnalysis.match(sections.indicators);
      if (indicatorsMatch) {
        analysis.keyIndicators = this.extractListItems(indicatorsMatch[1]);
      }

      const developmentsMatch = rawAnalysis.match(sections.developments);
      if (developmentsMatch) {
        analysis.probableDevelopments = this.extractListItems(developmentsMatch[1]);
      }

      const gapsMatch = rawAnalysis.match(sections.gaps);
      if (gapsMatch) {
        analysis.informationGaps = this.extractListItems(gapsMatch[1]);
      }

      const actionsMatch = rawAnalysis.match(sections.actions);
      if (actionsMatch) {
        analysis.tasks = this.extractListItems(actionsMatch[1]).map((item, i) => ({
          id: `task_${Date.now()}_${i}`,
          description: item,
          priority: i < 3 ? 'HIGH' : 'MEDIUM',
          status: 'pending',
          createdAt: new Date().toISOString()
        }));
      }
    } catch (error) {
      console.error('[OLLAMA] Parse error:', error.message);
    }

    return analysis;
  }

  extractListItems(text) {
    const items = [];
    const lines = text.split('\n');
    
    for (const line of lines) {
      const cleaned = line.replace(/^[\s\-\*\d\.]+/, '').trim();
      if (cleaned.length > 10) {
        items.push(cleaned);
      }
    }
    
    return items;
  }

  saveAnalysis(analysis, situation) {
    try {
      const db = this.loadDatabase();
      
      db.analyses.unshift({
        id: `analysis_${Date.now()}`,
        timestamp: new Date().toISOString(),
        analysis: analysis,
        situation: situation
      });
      
      // Keep only last 100 analyses
      db.analyses = db.analyses.slice(0, 100);
      
      this.saveDatabase(db);
      console.log('[OLLAMA] Analysis saved to database');
    } catch (error) {
      console.error('[OLLAMA] Save analysis error:', error.message);
    }
  }

  saveTasks(tasks) {
    try {
      const db = this.loadDatabase();
      
      for (const task of tasks) {
        // Check for duplicates (similar description)
        const isDuplicate = db.tasks.some(t => 
          t.description.toLowerCase().includes(task.description.toLowerCase().slice(0, 50)) ||
          task.description.toLowerCase().includes(t.description.toLowerCase().slice(0, 50))
        );
        
        if (!isDuplicate) {
          db.tasks.unshift(task);
        }
      }
      
      // Keep only last 200 tasks
      db.tasks = db.tasks.slice(0, 200);
      
      this.saveDatabase(db);
      console.log(`[OLLAMA] ${tasks.length} tasks saved`);
    } catch (error) {
      console.error('[OLLAMA] Save tasks error:', error.message);
    }
  }

  getLastAnalysis() {
    if (this.lastAnalysis) return this.lastAnalysis;
    
    try {
      const db = this.loadDatabase();
      if (db.analyses.length > 0) {
        return db.analyses[0];
      }
    } catch (error) {
      console.error('[OLLAMA] Get last analysis error:', error.message);
    }
    
    return {
      timestamp: null,
      situationAssessment: 'No analysis available. Ollama may not be running.',
      keyIndicators: [],
      probableDevelopments: [],
      tasks: [],
      threatLevel: 'UNKNOWN'
    };
  }

  getTasks(status = null) {
    try {
      const db = this.loadDatabase();
      let tasks = db.tasks;
      
      if (status) {
        tasks = tasks.filter(t => t.status === status);
      }
      
      return tasks;
    } catch (error) {
      console.error('[OLLAMA] Get tasks error:', error.message);
      return [];
    }
  }

  updateTaskStatus(taskId, status) {
    try {
      const db = this.loadDatabase();
      const task = db.tasks.find(t => t.id === taskId);
      
      if (task) {
        task.status = status;
        task.updatedAt = new Date().toISOString();
        this.saveDatabase(db);
        return true;
      }
    } catch (error) {
      console.error('[OLLAMA] Update task error:', error.message);
    }
    return false;
  }

  getAnalysisHistory(limit = 10) {
    try {
      const db = this.loadDatabase();
      return db.analyses.slice(0, limit);
    } catch (error) {
      console.error('[OLLAMA] Get history error:', error.message);
      return [];
    }
  }
}

module.exports = new OllamaAnalyst();

