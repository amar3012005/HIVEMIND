/**
 * DeepResearcher
 *
 * AgentScope-grade deep research engine with CSI persistence.
 * Runs natively inside HIVEMIND core.
 *
 * Flow:
 *   1. Create research project in CSI graph
 *   2. Decompose query → TaskStack (depth-first, 8 dimensions)
 *   3. For each task, run a ReAct (Reason → Act → Observe) loop:
 *      a. REASON: LLM decides next action (SEARCH_WEB, SEARCH_MEMORY, READ_URL, SYNTHESIZE, FINISH)
 *      b. ACT: Execute the chosen action with LLM-generated queries
 *      c. OBSERVE: Add results to findings, loop back to REASON
 *      d. Up to 6 steps per task for iterative refinement
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
   * @param {Object} [deps.browserRuntime] - HIVEMIND BrowserRuntime for web search/crawl
   * @param {Object} [deps.webJobStore] - Web job store for tracking
   * @param {Function} [deps.onEvent] - callback for live progress events
   */
  constructor({ memoryStore, recallFn, prisma, groqApiKey, browserRuntime, webJobStore, onEvent }) {
    this.memoryStore = memoryStore;
    this.recallFn = recallFn;
    this.prisma = prisma;
    this.groqApiKey = groqApiKey || process.env.GROQ_API_KEY;
    this.browserRuntime = browserRuntime || null;
    this.webJobStore = webJobStore || null;
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
    const maxSteps = 6;  // max reasoning steps per task
    let step = 0;

    while (step < maxSteps) {
      step++;

      // REASON: Ask LLM what to do next
      const reasoning = await this._reason(task.query, findings, step);
      this._emit('task.reasoning', { taskId: task.id, step, action: reasoning.action, thought: reasoning.thought });

      // Check if task is complete
      if (reasoning.action === 'FINISH') break;

      // ACT: Execute the chosen action
      let result;
      switch (reasoning.action) {
        case 'SEARCH_MEMORY':
          result = await this._actSearchMemory(reasoning.query || task.query, userId, orgId, projectId);
          break;
        case 'SEARCH_WEB':
          result = await this._actSearchWeb(reasoning.query || task.query);
          break;
        case 'READ_URL':
          result = await this._actReadUrl(reasoning.url);
          break;
        case 'SYNTHESIZE':
          result = await this._actSynthesize(task.query, findings);
          break;
        default:
          result = { type: 'error', content: 'Unknown action' };
      }

      // OBSERVE: Add result to findings
      if (result && result.content) {
        findings.push({
          id: randomUUID(),
          type: result.type || reasoning.action.toLowerCase(),
          title: result.title || reasoning.query || task.query,
          content: result.content,
          source: result.source || 'unknown',
          sourceId: result.sourceId || null,
          confidence: result.confidence || 0.6,
          taskQuery: task.query,
        });
        if (result.source) sources.push({ type: result.type, id: result.sourceId, title: result.title });
      }

      this._emit('task.observation', { taskId: task.id, step, type: result?.type, title: result?.title });
    }

    // Calculate confidence from findings
    const webFindings = findings.filter(f => f.type === 'web' || f.type === 'follow_up');
    const confidence = webFindings.length > 0
      ? Math.min(0.90, 0.5 + webFindings.length * 0.1)
      : findings.length > 0 ? 0.4 : 0.1;

    // Detect remaining gaps
    const gaps = await this._detectGaps(task.query, findings);

    return { findings, sources, confidence, gaps };
  }

  async _reason(query, findings, step) {
    const findingsSummary = findings.length > 0
      ? findings.slice(-5).map(f => `[${f.type}] ${f.title}: ${f.content?.slice(0, 150)}`).join('\n')
      : '(none yet)';

    const response = await this._llm(`You are a research agent working on this question:
"${query}"

Step ${step}. Findings so far:
${findingsSummary}

Choose your NEXT ACTION. Return JSON:
{
  "thought": "brief reasoning about what to do next",
  "action": "SEARCH_WEB" | "SEARCH_MEMORY" | "READ_URL" | "SYNTHESIZE" | "FINISH",
  "query": "search query if action is SEARCH_WEB or SEARCH_MEMORY",
  "url": "url to read if action is READ_URL"
}

Rules:
- Start with SEARCH_WEB for factual questions about the world
- Use SEARCH_MEMORY only when the question is about the user's own data
- Use READ_URL after finding promising URLs from web search
- Use SYNTHESIZE when you have enough findings to combine
- Use FINISH when the question is well-answered
- Generate specific, focused search queries — not the full research question`, { temperature: 0.3 });

    try {
      const parsed = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] || '{}');
      return {
        thought: parsed.thought || '',
        action: ['SEARCH_WEB', 'SEARCH_MEMORY', 'READ_URL', 'SYNTHESIZE', 'FINISH'].includes(parsed.action)
          ? parsed.action : 'SEARCH_WEB',
        query: parsed.query || query,
        url: parsed.url || null,
      };
    } catch {
      return { thought: 'Fallback to web search', action: step === 1 ? 'SEARCH_WEB' : 'FINISH', query, url: null };
    }
  }

  async _actSearchMemory(query, userId, orgId, projectId) {
    const memories = await this._recallFromCSI(query, userId, orgId, projectId);
    // Only return memories that are ACTUALLY relevant (score > 0.6)
    const relevant = memories.filter(m => (m.score || 0) > 0.6);
    if (relevant.length === 0) return { type: 'memory', content: null };

    const combined = relevant.slice(0, 5).map(m => `- ${m.title || ''}: ${(m.content || '').slice(0, 200)}`).join('\n');
    return {
      type: 'memory',
      title: `Memory recall: ${query.slice(0, 50)}`,
      content: combined,
      source: 'hivemind_memory',
      sourceId: relevant[0]?.id,
      confidence: relevant[0]?.score || 0.6,
    };
  }

  async _actSearchWeb(query) {
    const results = await this._webSearch(query);
    if (results.length === 0) return { type: 'web', content: null };

    const combined = results.slice(0, 5).map(r =>
      `[${r.title || 'Untitled'}](${r.url || ''}): ${(r.snippet || r.summary || r.content || '').slice(0, 300)}`
    ).join('\n\n');

    return {
      type: 'web',
      title: `Web: ${query.slice(0, 50)}`,
      content: combined,
      source: results[0]?.url || 'web',
      sourceId: results[0]?.url,
      confidence: 0.7,
      _urls: results.map(r => r.url).filter(Boolean), // pass URLs for potential follow-up
    };
  }

  async _actReadUrl(url) {
    if (!url) return { type: 'follow_up', content: null };
    const content = await this._followUpRead(url);
    if (!content) return { type: 'follow_up', content: null };

    return {
      type: 'follow_up',
      title: `Deep read: ${url}`,
      content: content.slice(0, 3000),
      source: url,
      sourceId: url,
      confidence: 0.75,
    };
  }

  async _actSynthesize(query, findings) {
    if (findings.length === 0) return { type: 'synthesis', content: null };

    const material = findings.slice(0, 10).map(f => f.content?.slice(0, 300) || '').join('\n---\n');
    const synthesis = await this._llm(
      `Synthesize these research findings into a concise summary answering: "${query}"\n\nFindings:\n${material}\n\nWrite a clear, factual summary:`,
      { temperature: 0.4 }
    );

    return {
      type: 'synthesis',
      title: `Synthesis: ${query.slice(0, 50)}`,
      content: synthesis,
      source: 'llm_synthesis',
      confidence: 0.8,
    };
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
      // First check project-specific research findings (prior research)
      const projectResults = await this.recallFn(this.memoryStore, {
        query_context: query,
        user_id: userId,
        org_id: orgId,
        project: projectId,
        max_memories: 5,
      });
      const projectMemories = (projectResults.memories || []).filter(m => (m.score || 0) > 0.5);

      // Then check main memory but with HIGH threshold — only borrow if truly relevant
      const mainResults = await this.recallFn(this.memoryStore, {
        query_context: query,
        user_id: userId,
        org_id: orgId,
        max_memories: 5,
      });
      // Very strict: only borrow from main memory if score > 0.75
      const mainMemories = (mainResults.memories || []).filter(m => (m.score || 0) > 0.75);

      // Deduplicate
      const seen = new Set(projectMemories.map(m => m.id));
      const combined = [...projectMemories];
      for (const m of mainMemories) {
        if (!seen.has(m.id)) combined.push(m);
      }
      return combined.slice(0, 8);
    } catch {
      return [];
    }
  }

  async _webSearch(query) {
    this._emit('web.searching', { query });

    // Try browserRuntime first (LightPanda)
    if (this.browserRuntime) {
      try {
        const result = await this.browserRuntime.search({ query, domains: [], limit: 5 });
        const results = Array.isArray(result.results) ? result.results : [];
        if (results.length > 0) {
          this._emit('web.results', { query, count: results.length, via: 'lightpanda' });
          return results;
        }
      } catch {}
    }

    // Fallback: DuckDuckGo HTML scrape (no browser needed)
    try {
      const encoded = encodeURIComponent(query);
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HivemindResearch/1.0)',
          'Accept': 'text/html',
        },
      });
      if (!res.ok) throw new Error(`DDG ${res.status}`);
      const html = await res.text();

      // Parse results from DDG HTML
      const results = [];
      const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = resultPattern.exec(html)) !== null && results.length < 5) {
        const url = decodeURIComponent((match[1].match(/uddg=([^&]+)/) || [])[1] || match[1]);
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        const snippet = match[3].replace(/<[^>]+>/g, '').trim();
        if (url && title && url.startsWith('http')) {
          results.push({ url, title, snippet, summary: snippet });
        }
      }

      // Simpler fallback pattern if the above doesn't match
      if (results.length === 0) {
        const linkPattern = /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        while ((match = linkPattern.exec(html)) !== null && results.length < 5) {
          const url = decodeURIComponent((match[1].match(/uddg=([^&]+)/) || [])[1] || match[1]);
          const title = match[2].replace(/<[^>]+>/g, '').trim();
          if (url && title && url.startsWith('http') && !url.includes('duckduckgo.com')) {
            results.push({ url, title, snippet: title, summary: title });
          }
        }
      }

      this._emit('web.results', { query, count: results.length, via: 'duckduckgo' });
      return results;
    } catch (err) {
      this._emit('web.error', { query, error: err.message });
      return [];
    }
  }

  async _followUpRead(url) {
    if (!url) return null;
    this._emit('web.reading', { url });

    // Try browserRuntime first
    if (this.browserRuntime) {
      try {
        const result = await this.browserRuntime.crawl({ urls: [url], depth: 0, pageLimit: 1 });
        const pages = Array.isArray(result.results) ? result.results : [];
        const content = pages[0]?.text || pages[0]?.content || pages[0]?.markdown || null;
        if (content) {
          this._emit('web.read_complete', { url, length: content.length, via: 'lightpanda' });
          return content;
        }
      } catch {}
    }

    // Fallback: direct fetch + HTML strip
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HivemindResearch/1.0)', 'Accept': 'text/html' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const html = await res.text();
      // Strip HTML tags, scripts, styles
      let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      // Take meaningful content (skip first 200 chars likely nav/header)
      text = text.slice(200, 5000).trim();
      if (text.length > 100) {
        this._emit('web.read_complete', { url, length: text.length, via: 'fetch' });
        return text;
      }
      return null;
    } catch (err) {
      this._emit('web.read_error', { url, error: err.message });
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
      // Only include genuinely relevant findings (not random memory noise)
      const relevant = findings.filter(f => f.confidence > 0.5 && f.type !== 'memory');
      const findingSummaries = relevant.length > 0
        ? relevant.slice(0, 8).map(f => f.content.slice(0, 200)).join('\n- ')
        : '(No relevant findings yet)';
      const response = await this._llm(
        `You are identifying research gaps. Given the original research question and findings so far, output specific SUB-QUESTIONS that still need answering.\n\n` +
        `Original question: ${query}\n\n` +
        `Findings so far:\n- ${findingSummaries}\n\n` +
        `Output 1-3 specific, searchable sub-questions as a JSON array of strings. ` +
        `Each sub-question should be a concrete, web-searchable query (not meta-commentary). ` +
        `Example: ["EU AI Act compliance requirements for SaaS 2026", "German data protection GDPR AI Act overlap"]\n` +
        `If the question is well-covered, return [].`,
        { temperature: 0.3 }
      );
      const parsed = JSON.parse(response.match(/\[.*\]/s)?.[0] || '[]');
      return Array.isArray(parsed) ? parsed.filter(g => typeof g === 'string' && g.length > 10).slice(0, 3) : [];
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
