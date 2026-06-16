const axios = require('axios');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const llm = require('./llm-client');

/**
 * Ollama Entity Analyst Module
 *
 * Provides AI-powered analysis of individual entities of interest
 * (flights, vessels) using local Ollama LLM.
 */

class OllamaEntityAnalyst extends EventEmitter {
  constructor() {
    super();
    this.ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    this.model = process.env.OLLAMA_MODEL || 'llama3:8b';
    this.analysesPath = path.join(__dirname, '..', 'data', 'entity-analyses.json');
    this.analyses = null;
    this.analysisQueue = [];
    this.isProcessing = false;
    this.cooldownMs = 10000; // 10 seconds between analyses (global rate limit)
    this.lastAnalysisTime = 0;
    this.recentByEntity = new Map();           // key -> { time, record } per-entity dedup
    this.perEntityCooldownMs = 30 * 60 * 1000; // don't re-analyze same entity within 30min
    this.loadAnalyses();
  }

  /**
   * Load analyses from file
   */
  loadAnalyses() {
    try {
      if (fs.existsSync(this.analysesPath)) {
        const data = fs.readFileSync(this.analysesPath, 'utf8');
        this.analyses = JSON.parse(data);
        console.log('[ENTITY-ANALYST] Loaded analysis history');
        return true;
      }
    } catch (error) {
      console.error('[ENTITY-ANALYST] Error loading analyses:', error.message);
    }

    this.analyses = {
      version: '1.0.0',
      lastUpdate: null,
      analyses: [],
      entityHistory: {}
    };
    return false;
  }

  /**
   * Save analyses to file
   */
  saveAnalyses() {
    try {
      this.analyses.lastUpdate = new Date().toISOString();
      fs.writeFileSync(this.analysesPath, JSON.stringify(this.analyses, null, 2));
    } catch (error) {
      console.error('[ENTITY-ANALYST] Error saving analyses:', error.message);
    }
  }

  /**
   * Check if Ollama is available
   */
  async isAvailable() {
    return llm.isAvailable(5000);
  }

  /**
   * Analyze a flight entity
   */
  async analyzeFlight(flight, trigger = 'manual') {
    const prompt = `You are a military intelligence analyst. Analyze this military flight detection:

FLIGHT DATA:
- Callsign: ${flight.callsign || 'Unknown'}
- Aircraft Type: ${flight.aircraftType || flight.category || 'Unknown'}
- Position: ${flight.latitude?.toFixed(4) || '?'}, ${flight.longitude?.toFixed(4) || '?'}
- Altitude: ${flight.altitude || '?'} ft
- Speed: ${flight.velocity || flight.speed || '?'} knots
- Heading: ${flight.heading || '?'}°
- Region: ${flight.region?.name || 'Unknown'}
- Origin Country: ${flight.origin || 'Unknown'}
- Threat Level: ${flight.threatLevel || flight.matchInfo?.priority || 'Unknown'}
- Match Type: ${flight.matchInfo?.type || flight.category || 'Unknown'}
- Notes: ${flight.matchInfo?.notes || 'None'}

ANALYSIS TRIGGER: ${trigger}

Provide a concise intelligence assessment. Respond with ONLY a single valid JSON
object (no markdown, no prose) of this exact shape:
{
  "mission": "likely mission type and purpose",
  "significance": "LOW|MEDIUM|HIGH|CRITICAL",
  "context": "brief relevant geopolitical context",
  "assessment": "1-2 sentence intelligence summary"
}`;

    return await this.analyze('flight', flight.callsign, flight, prompt, trigger);
  }

  /**
   * Analyze a vessel entity
   */
  async analyzeVessel(vessel, trigger = 'manual') {
    const prompt = `You are a naval intelligence analyst. Analyze this vessel of interest detection:

VESSEL DATA:
- Name: ${vessel.name || 'Unknown'}
- MMSI: ${vessel.mmsi || 'Unknown'}
- Type: ${vessel.shipTypeName || vessel.matchInfo?.type || 'Unknown'}
- Position: ${vessel.latitude?.toFixed(4) || '?'}, ${vessel.longitude?.toFixed(4) || '?'}
- Speed: ${vessel.speed || '?'} knots
- Course: ${vessel.course || '?'}°
- Destination: ${vessel.destination || 'Unknown'}
- Flag/Origin: ${vessel.flag || vessel.origin || 'Unknown'}
- Dimensions: ${vessel.dimensions?.length || '?'}m x ${vessel.dimensions?.width || '?'}m
- Priority: ${vessel.matchInfo?.priority || 'Unknown'}
- Hull Number: ${vessel.matchInfo?.hull || 'N/A'}
- Notes: ${vessel.matchInfo?.notes || 'None'}

German Waters Status: ${vessel.germanWaters ? 'YES - ' + (vessel.germanZone || 'German waters') : 'No'}

ANALYSIS TRIGGER: ${trigger}

Provide a concise intelligence assessment. Respond with ONLY a single valid JSON
object (no markdown, no prose) of this exact shape:
{
  "mission": "vessel significance and likely mission",
  "significance": "LOW|MEDIUM|HIGH|CRITICAL",
  "context": "brief relevant maritime/geopolitical context",
  "assessment": "1-2 sentence intelligence summary"
}`;

    return await this.analyze('vessel', vessel.mmsi || vessel.name, vessel, prompt, trigger);
  }

  /**
   * Core analysis function
   */
  async analyze(entityType, entityId, entity, prompt, trigger) {
    const now = Date.now();

    // Per-entity dedup: skip the LLM call if this entity was analyzed recently
    const entityKey = `${entityType}:${entityId}`;
    const recent = this.recentByEntity.get(entityKey);
    if (recent && now - recent.time < this.perEntityCooldownMs) {
      return recent.record || { success: true, cached: true, entityType, entityId };
    }

    // Check global cooldown (rate limit across all entities)
    if (now - this.lastAnalysisTime < this.cooldownMs) {
      console.log('[ENTITY-ANALYST] Cooldown active, queuing analysis');
      return this.queueAnalysis(entityType, entityId, entity, prompt, trigger);
    }

    // Check availability
    const available = await this.isAvailable();
    if (!available) {
      console.log('[ENTITY-ANALYST] Ollama not available');
      return {
        success: false,
        error: 'Ollama not available',
        entityId,
        entityType
      };
    }

    try {
      console.log(`[ENTITY-ANALYST] Analyzing ${entityType}: ${entityId}`);
      this.lastAnalysisTime = now;

      const raw = await llm.complete(
        {
          system: 'You are a military/naval intelligence analyst. Output ONLY valid JSON, no prose.',
          user: prompt,
        },
        { maxTokens: 400, temperature: 0.5, timeout: 120000, json: true, model: process.env.LLM_MODEL_FAST || undefined }
      );

      if (raw) {
        const analysis = this.parseAnalysisResponse(raw);

        const analysisRecord = {
          id: `analysis_${entityType}_${entityId}_${now}`,
          entityType,
          entityId,
          timestamp: new Date().toISOString(),
          trigger,
          entity: this.sanitizeEntity(entity),
          analysis,
          raw: raw
        };

        // Store analysis
        this.storeAnalysis(analysisRecord);

        // Emit event
        this.emit('analysis-complete', analysisRecord);

        console.log(`[ENTITY-ANALYST] Analysis complete for ${entityId}`);
        const result = { success: true, ...analysisRecord };
        this.recentByEntity.set(entityKey, { time: now, record: result });
        return result;
      }
    } catch (error) {
      console.error(`[ENTITY-ANALYST] Analysis error: ${error.message}`);
      return {
        success: false,
        error: error.message,
        entityId,
        entityType
      };
    }

    return {
      success: false,
      error: 'No response from Ollama',
      entityId,
      entityType
    };
  }

  /**
   * Parse analysis response
   */
  parseAnalysisResponse(rawResponse) {
    const analysis = {
      mission: '',
      significance: 'UNKNOWN',
      context: '',
      assessment: '',
      raw: rawResponse
    };

    // JSON-first: the model returns a clean JSON object in json mode
    try {
      const jsonStr = rawResponse.slice(rawResponse.indexOf('{'), rawResponse.lastIndexOf('}') + 1);
      if (jsonStr) {
        const j = JSON.parse(jsonStr);
        const sig = String(j.significance || '').toUpperCase();
        analysis.mission = j.mission || '';
        analysis.significance = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(sig) ? sig : 'UNKNOWN';
        analysis.context = j.context || '';
        analysis.assessment = j.assessment || '';
        if (analysis.mission || analysis.assessment) return analysis;
      }
    } catch (e) {
      // not JSON — fall through to legacy regex parsing
    }

    try {
      // Extract MISSION
      const missionMatch = rawResponse.match(/MISSION:\s*(.+?)(?=SIGNIFICANCE:|CONTEXT:|ASSESSMENT:|$)/is);
      if (missionMatch) {
        analysis.mission = missionMatch[1].trim();
      }

      // Extract SIGNIFICANCE
      const sigMatch = rawResponse.match(/SIGNIFICANCE:\s*(LOW|MEDIUM|HIGH|CRITICAL)/i);
      if (sigMatch) {
        analysis.significance = sigMatch[1].toUpperCase();
      }

      // Extract CONTEXT
      const contextMatch = rawResponse.match(/CONTEXT:\s*(.+?)(?=ASSESSMENT:|$)/is);
      if (contextMatch) {
        analysis.context = contextMatch[1].trim();
      }

      // Extract ASSESSMENT
      const assessMatch = rawResponse.match(/ASSESSMENT:\s*(.+?)$/is);
      if (assessMatch) {
        analysis.assessment = assessMatch[1].trim();
      }
    } catch (error) {
      console.error('[ENTITY-ANALYST] Parse error:', error.message);
    }

    return analysis;
  }

  /**
   * Sanitize entity for storage (remove circular refs, trim data)
   */
  sanitizeEntity(entity) {
    const sanitized = {};

    const allowedKeys = [
      'callsign', 'mmsi', 'name', 'latitude', 'longitude',
      'altitude', 'speed', 'velocity', 'heading', 'course',
      'destination', 'origin', 'flag', 'shipType', 'shipTypeName',
      'category', 'aircraftType', 'threatLevel', 'region',
      'matchInfo', 'germanWaters', 'germanZone', 'dimensions'
    ];

    for (const key of allowedKeys) {
      if (entity[key] !== undefined) {
        sanitized[key] = entity[key];
      }
    }

    return sanitized;
  }

  /**
   * Store analysis in history
   */
  storeAnalysis(analysisRecord) {
    // Add to analyses array
    this.analyses.analyses.unshift(analysisRecord);

    // Keep only last 500 analyses
    if (this.analyses.analyses.length > 500) {
      this.analyses.analyses = this.analyses.analyses.slice(0, 500);
    }

    // Update entity history
    const key = `${analysisRecord.entityType}_${analysisRecord.entityId}`;
    if (!this.analyses.entityHistory[key]) {
      this.analyses.entityHistory[key] = [];
    }
    this.analyses.entityHistory[key].unshift({
      timestamp: analysisRecord.timestamp,
      analysisId: analysisRecord.id,
      significance: analysisRecord.analysis?.significance
    });

    // Keep only last 20 analyses per entity
    if (this.analyses.entityHistory[key].length > 20) {
      this.analyses.entityHistory[key] = this.analyses.entityHistory[key].slice(0, 20);
    }

    this.saveAnalyses();
  }

  /**
   * Queue analysis for later processing
   */
  queueAnalysis(entityType, entityId, entity, prompt, trigger) {
    this.analysisQueue.push({
      entityType,
      entityId,
      entity,
      prompt,
      trigger,
      queuedAt: Date.now()
    });

    // Start processing if not already
    if (!this.isProcessing) {
      this.processQueue();
    }

    return {
      success: true,
      queued: true,
      entityId,
      entityType,
      queuePosition: this.analysisQueue.length
    };
  }

  /**
   * Process queued analyses
   */
  async processQueue() {
    if (this.isProcessing || this.analysisQueue.length === 0) return;

    this.isProcessing = true;

    while (this.analysisQueue.length > 0) {
      // Wait for cooldown
      const timeSinceLast = Date.now() - this.lastAnalysisTime;
      if (timeSinceLast < this.cooldownMs) {
        await new Promise(resolve => setTimeout(resolve, this.cooldownMs - timeSinceLast));
      }

      const item = this.analysisQueue.shift();
      if (item) {
        await this.analyze(
          item.entityType,
          item.entityId,
          item.entity,
          item.prompt,
          item.trigger
        );
      }
    }

    this.isProcessing = false;
  }

  /**
   * Get recent analyses
   */
  getRecentAnalyses(limit = 10) {
    return this.analyses.analyses.slice(0, limit);
  }

  /**
   * Get analysis by ID
   */
  // Loader entry point — returns the current analyses snapshot for globalState
  // (getAnalysis is a by-id lookup, not a state-getter, so it must not be the
  // detected update method).
  update() {
    const list = (this.analyses && this.analyses.analyses) || [];
    return {
      timestamp: new Date(),
      count: list.length,
      recent: list.slice(0, 20),
      queued: this.analysisQueue ? this.analysisQueue.length : 0
    };
  }

  getAnalysis(analysisId) {
    return this.analyses.analyses.find(a => a.id === analysisId);
  }

  /**
   * Get analyses for entity
   */
  getEntityAnalyses(entityType, entityId, limit = 10) {
    return this.analyses.analyses
      .filter(a => a.entityType === entityType && a.entityId === entityId)
      .slice(0, limit);
  }

  /**
   * Get analysis history for entity
   */
  getEntityHistory(entityType, entityId) {
    const key = `${entityType}_${entityId}`;
    return this.analyses.entityHistory[key] || [];
  }

  /**
   * Trigger analysis based on event
   */
  async triggerAnalysis(type, entity, event) {
    const triggerMap = {
      'newCriticalFlight': 'New critical priority flight detected',
      'enteringHotzone': 'Entity entering hotzone region',
      'unusualPattern': 'Unusual flight pattern detected',
      'rareCallsign': 'Rare callsign observed',
      'militaryVessel': 'Military vessel detected',
      'enteringGermanWaters': 'Vessel entering German waters',
      'carrierMovement': 'Aircraft carrier position update',
      'submarineSurfacing': 'Possible submarine surface detection'
    };

    const trigger = triggerMap[event] || event;

    if (type === 'flight') {
      return await this.analyzeFlight(entity, trigger);
    } else if (type === 'vessel') {
      return await this.analyzeVessel(entity, trigger);
    }

    return { success: false, error: 'Unknown entity type' };
  }

  /**
   * Get summary statistics
   */
  getSummary() {
    const analyses = this.analyses.analyses;

    const byType = {};
    const bySignificance = {};
    const byTrigger = {};

    analyses.forEach(a => {
      byType[a.entityType] = (byType[a.entityType] || 0) + 1;
      bySignificance[a.analysis?.significance || 'UNKNOWN'] =
        (bySignificance[a.analysis?.significance || 'UNKNOWN'] || 0) + 1;
      byTrigger[a.trigger] = (byTrigger[a.trigger] || 0) + 1;
    });

    return {
      totalAnalyses: analyses.length,
      uniqueEntities: Object.keys(this.analyses.entityHistory).length,
      byType,
      bySignificance,
      byTrigger,
      queueLength: this.analysisQueue.length,
      isProcessing: this.isProcessing
    };
  }
}

module.exports = new OllamaEntityAnalyst();
