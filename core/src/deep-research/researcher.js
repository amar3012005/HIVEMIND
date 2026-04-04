/**
 * DeepResearcher
 *
 * AgentScope-grade deep research engine with CSI persistence.
 * Runs natively inside HIVEMIND core.
 *
 * Flow:
 *   1. Create research project in CSI graph
 *   2. Decompose query → TaskStack (depth-first, 8 dimensions)
 *   3. For each task:
 *      a. Check CSI memory (prior research?)
 *      b. Web search if gaps remain
 *      c. Follow-up: read top URLs deeply
 *      d. Extract claims, save as research-finding
 *      e. Identify remaining gaps → push subtasks
 *   4. Reflect: sufficient confidence? If not, rephrase & retry
 *   5. Synthesize final report from all findings
 *   6. Save trail + report to CSI graph
 *
 * Every step emits events for real-time frontend updates.
 */

import { randomUUID } from 'node:crypto';
import { TaskStack, DIMENSIONS } from './task-stack.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const MAX_REFLECTION_ROUNDS = 2;

export class DeepResearcher {
  /**
   * @param {Object} deps
   * @param {import('../memory/prisma-graph-store.js').PrismaGraphStore} deps.memoryStore
   * @param {Function} deps.recallFn - recallPersistedMemories function
   * @param {Object} deps.prisma - Prisma client for direct queries
   * @param {string} deps.groqApiKey
   * @param {Function} [deps.onEvent] - callback for live progress events
   */
  constructor({ memoryStore, recallFn, prisma, groqApiKey, onEvent }) {
    this.memoryStore = memoryStore;
    this.recallFn = recallFn;
    this.prisma = prisma;
    this.groqApiKey = groqApiKey || process.env.GROQ_API_KEY;
    this.onEvent = onEvent || (() => {});
  }

  /**
   * Run a full deep research session.
   * @param {string} query - the research question
   * @param {string} userId
   * @param {string} orgId
   * @param {Object} [options]
   * @returns {Promise<Object>} ResearchResult
   */
  async research(query, userId, orgId, options = {}) {
    const sessionId = randomUUID();
    const projectId = `research/${this._slugify(query)}`;
    const startTime = Date.now();

    this._emit('research.started', { sessionId, query, projectId });

    // Step 0: Check for prior research on this topic
    const priorFindings = await this._checkPriorResearch(query, userId, orgId, projectId);
    if (priorFindings.length >= 5 && !options.forceRefresh) {
      this._emit('research.cached', { sessionId, findingCount: priorFindings.length });
      const report = await this._synthesizeReport(query, priorFindings, []);
      return {
        sessionId,
        projectId,
        query,
        report,
        findings: priorFindings,
        fromCache: true,
        durationMs: Date.now() - startTime,
        taskProgress: { total: 0, completed: 0, confidence: 0.9 },
      };
    }

    // Step 1: Decompose into subtasks
    const stack = new TaskStack();
    const root = stack.createRoot(query);

    // Use LLM to pick relevant dimensions
    const dimensions = await this._selectDimensions(query);
    this._emit('research.decomposed', { sessionId, dimensions, taskCount: dimensions.length + 1 });

    if (dimensions.length > 0) {
      stack.decompose(root.id, dimensions);
    }

    // Step 2: Process each task (depth-first)
    let reflectionRound = 0;
    const allFindings = [...priorFindings];
    const allSources = [];

    while (true) {
      const task = stack.next();
      if (!task) break;

      this._emit('task.started', {
        sessionId,
        taskId: task.id,
        query: task.query,
        depth: task.depth,
        dimension: task.dimension,
        progress: stack.getProgress(),
      });

      try {
        const result = await this._executeTask(task, userId, orgId, projectId);

        stack.complete(task.id, {
          findings: result.findings,
          confidence: result.confidence,
          gaps: result.gaps,
        });

        allFindings.push(...result.findings);
        allSources.push(...result.sources);

        // Save findings to CSI graph
        for (const finding of result.findings) {
          await this._saveFindingToCSI(finding, userId, orgId, projectId);
        }

        this._emit('task.completed', {
          sessionId,
          taskId: task.id,
          findingCount: result.findings.length,
          confidence: result.confidence,
          gaps: result.gaps,
          progress: stack.getProgress(),
        });

      } catch (err) {
        stack.fail(task.id, err.message);
        this._emit('task.failed', { sessionId, taskId: task.id, error: err.message });
      }
    }

    // Step 3: Reflect — is confidence sufficient?
    const progress = stack.getProgress();
    if (progress.confidence < 0.75 && reflectionRound < MAX_REFLECTION_ROUNDS) {
      reflectionRound++;
      this._emit('research.reflecting', { sessionId, round: reflectionRound, confidence: progress.confidence });

      const gaps = stack.getRemainingGaps();
      const rephrased = await this._reflectAndRephrase(query, gaps, allFindings);

      for (const newQuery of rephrased.slice(0, 3)) {
        stack.addSubtask(root.id, newQuery, 'gaps');
      }

      // Continue processing newly added tasks
      while (true) {
        const task = stack.next();
        if (!task) break;
        try {
          const result = await this._executeTask(task, userId, orgId, projectId);
          stack.complete(task.id, result);
          allFindings.push(...result.findings);
          allSources.push(...result.sources);
          for (const finding of result.findings) {
            await this._saveFindingToCSI(finding, userId, orgId, projectId);
          }
          this._emit('task.completed', { sessionId, taskId: task.id, ...result, progress: stack.getProgress() });
        } catch (err) {
          stack.fail(task.id, err.message);
        }
      }
    }

    // Step 4: Synthesize final report
    this._emit('research.synthesizing', { sessionId, findingCount: allFindings.length });

    const report = await this._synthesizeReport(query, allFindings, stack.getRemainingGaps());

    // Step 5: Save trail to CSI
    await this._saveTrailToCSI(sessionId, query, stack, report, userId, orgId, projectId);

    this._emit('research.completed', {
      sessionId,
      projectId,
      durationMs: Date.now() - startTime,
      findingCount: allFindings.length,
      taskProgress: stack.getProgress(),
    });

    return {
      sessionId,
      projectId,
      query,
      report,
      findings: allFindings,
      sources: allSources,
      gaps: stack.getRemainingGaps(),
      fromCache: false,
      durationMs: Date.now() - startTime,
      taskProgress: stack.getProgress(),
      trail: stack.toJSON(),
    };
  }

  // ─── Internal Methods ──────────────────────────────────────

  async _executeTask(task, userId, orgId, projectId) {
    const findings = [];
    const sources = [];
    let confidence = 0;
    const gaps = [];

    // Phase 1: Check CSI memory
    const memoryResults = await this._recallFromCSI(task.query, userId, orgId, projectId);
    for (const mem of memoryResults) {
      findings.push({
        id: randomUUID(),
        type: 'memory',
        title: mem.title || task.query,
        content: mem.content,
        source: mem.source || 'hivemind_memory',
        sourceId: mem.id,
        confidence: mem.score || 0.7,
        taskQuery: task.query,
      });
      sources.push({ type: 'memory', id: mem.id, title: mem.title });
    }

    if (memoryResults.length > 0) {
      confidence = Math.min(0.85, memoryResults.reduce((s, m) => s + (m.score || 0.6), 0) / memoryResults.length);
    }

    // Phase 2: Web search if memory insufficient
    if (confidence < 0.70) {
      const webResults = await this._webSearch(task.query);
      for (const result of webResults) {
        findings.push({
          id: randomUUID(),
          type: 'web',
          title: result.title || task.query,
          content: result.snippet || result.summary || '',
          source: result.url || 'web',
          sourceId: result.url,
          confidence: 0.65,
          taskQuery: task.query,
        });
        sources.push({ type: 'web', id: result.url, title: result.title });
      }

      // Phase 3: Follow-up reads on top URLs
      if (webResults.length > 0) {
        const topUrls = webResults.slice(0, 2).map(r => r.url).filter(Boolean);
        for (const url of topUrls) {
          try {
            const deepContent = await this._followUpRead(url);
            if (deepContent) {
              findings.push({
                id: randomUUID(),
                type: 'follow_up',
                title: `Deep read: ${url}`,
                content: deepContent.slice(0, 2000),
                source: url,
                sourceId: url,
                confidence: 0.72,
                taskQuery: task.query,
              });
            }
          } catch {
            // Non-fatal: follow-up reads can fail
          }
        }
      }

      confidence = Math.min(0.90, findings.length > 0
        ? findings.reduce((s, f) => s + f.confidence, 0) / findings.length
        : 0.2);
    }

    // Phase 4: Gap detection via LLM
    if (findings.length > 0 && confidence < 0.85) {
      const detectedGaps = await this._detectGaps(task.query, findings);
      gaps.push(...detectedGaps);
    }

    return { findings, sources, confidence, gaps };
  }

  async _checkPriorResearch(query, userId, orgId, projectId) {
    try {
      const result = await this.recallFn(this.memoryStore, {
        query_context: query,
        user_id: userId,
        org_id: orgId,
        project: projectId,
        tags: ['research-finding'],
        max_memories: 10,
      });
      return (result.memories || []).filter(m => (m.score || 0) > 0.5);
    } catch {
      return [];
    }
  }

  async _recallFromCSI(query, userId, orgId, projectId) {
    try {
      const result = await this.recallFn(this.memoryStore, {
        query_context: query,
        user_id: userId,
        org_id: orgId,
        max_memories: 8,
      });
      return (result.memories || []).filter(m => (m.score || 0) > 0.3);
    } catch {
      return [];
    }
  }

  async _webSearch(query) {
    try {
      const res = await fetch(`http://localhost:3001/api/web/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal': 'true' },
        body: JSON.stringify({ query, limit: 5 }),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.results || data.items || [];
    } catch {
      return [];
    }
  }

  async _followUpRead(url) {
    try {
      const res = await fetch(`http://localhost:3001/api/web/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal': 'true' },
        body: JSON.stringify({ urls: [url], depth: 0, page_limit: 1 }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      // Extract text content from crawl result
      const pages = data.results || data.pages || [];
      return pages[0]?.text || pages[0]?.content || null;
    } catch {
      return null;
    }
  }

  async _selectDimensions(query) {
    try {
      const response = await this._llm(
        `Given this research question, select which research dimensions are most relevant. Return ONLY a JSON array of dimension names.\n\nDimensions: ${DIMENSIONS.join(', ')}\n\nQuestion: ${query}\n\nReturn 3-5 most relevant dimensions as JSON array:`,
        { temperature: 0.3 }
      );
      const parsed = JSON.parse(response.match(/\[.*\]/s)?.[0] || '[]');
      return parsed.filter(d => DIMENSIONS.includes(d)).slice(0, 5);
    } catch {
      // Fallback: pick first 4 dimensions
      return DIMENSIONS.slice(0, 4);
    }
  }

  async _detectGaps(query, findings) {
    try {
      const findingSummaries = findings.slice(0, 8).map(f => f.content.slice(0, 200)).join('\n- ');
      const response = await this._llm(
        `Given this research query and current findings, what important gaps remain?\n\nQuery: ${query}\n\nFindings so far:\n- ${findingSummaries}\n\nList 1-3 specific gaps as a JSON array of strings. If well-covered, return [].`,
        { temperature: 0.3 }
      );
      const parsed = JSON.parse(response.match(/\[.*\]/s)?.[0] || '[]');
      return Array.isArray(parsed) ? parsed.filter(g => typeof g === 'string').slice(0, 3) : [];
    } catch {
      return [];
    }
  }

  async _reflectAndRephrase(query, gaps, findings) {
    if (gaps.length === 0) return [];
    try {
      const gapList = gaps.map(g => g.gap || g).join('\n- ');
      const response = await this._llm(
        `The research on "${query}" has gaps:\n- ${gapList}\n\nRephrase each gap as a specific, searchable sub-question. Return a JSON array of strings.`,
        { temperature: 0.4 }
      );
      const parsed = JSON.parse(response.match(/\[.*\]/s)?.[0] || '[]');
      return Array.isArray(parsed) ? parsed.filter(q => typeof q === 'string').slice(0, 3) : [];
    } catch {
      return gaps.map(g => g.gap || String(g));
    }
  }

  async _synthesizeReport(query, findings, gaps) {
    const findingTexts = findings.slice(0, 20).map((f, i) =>
      `[${i + 1}] (${f.type || 'unknown'}) ${f.title}: ${f.content?.slice(0, 300) || 'No content'}`
    ).join('\n\n');

    const gapTexts = gaps.length > 0
      ? `\n\nRemaining gaps:\n${gaps.map(g => `- ${g.gap || g}`).join('\n')}`
      : '';

    const report = await this._llm(
      `Synthesize a comprehensive research report from the findings below.\n\n` +
      `Research Question: ${query}\n\n` +
      `Findings:\n${findingTexts}${gapTexts}\n\n` +
      `Write a well-structured report with:\n` +
      `1. Executive Summary (2-3 sentences)\n` +
      `2. Key Findings (organized by theme)\n` +
      `3. Evidence & Sources (reference finding numbers [1], [2], etc.)\n` +
      `4. Gaps & Limitations\n` +
      `5. Conclusion\n\n` +
      `Use markdown formatting. Be thorough but concise.`,
      { temperature: 0.5, maxTokens: 4000 }
    );

    return report;
  }

  async _saveFindingToCSI(finding, userId, orgId, projectId) {
    try {
      await this.memoryStore.createMemory({
        id: finding.id,
        user_id: userId,
        org_id: orgId,
        project: projectId,
        content: `${finding.title}\n\n${finding.content}`,
        title: finding.title,
        memory_type: 'fact',
        tags: ['research-finding', `source:${finding.type}`, `query:${finding.taskQuery?.slice(0, 50) || 'unknown'}`],
        is_latest: true,
        importance_score: finding.confidence || 0.7,
        metadata: {
          research_type: finding.type,
          source_url: finding.source,
          source_id: finding.sourceId,
          confidence: finding.confidence,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch {
      // Non-fatal
    }
  }

  async _saveTrailToCSI(sessionId, query, stack, report, userId, orgId, projectId) {
    try {
      await this.memoryStore.createMemory({
        id: randomUUID(),
        user_id: userId,
        org_id: orgId,
        project: projectId,
        content: `Research Trail: ${query}\n\n${report.slice(0, 1000)}`,
        title: `Research: ${query.slice(0, 80)}`,
        memory_type: 'decision',
        tags: ['research-trail', 'csi-trail', 'research-report'],
        is_latest: true,
        importance_score: 0.9,
        metadata: {
          research_session_id: sessionId,
          task_count: stack.getProgress().total,
          finding_count: stack.getProgress().findingCount,
          confidence: stack.getProgress().confidence,
          trail: stack.toJSON(),
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch {
      // Non-fatal
    }
  }

  async _llm(prompt, { temperature = 0.5, maxTokens = 2000 } = {}) {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.groqApiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) throw new Error(`LLM call failed: ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  _emit(type, data) {
    try { this.onEvent({ type, timestamp: new Date().toISOString(), ...data }); } catch {}
  }

  _slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/-$/, '');
  }
}
