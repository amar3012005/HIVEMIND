/**
 * PageIndex Classifier — LLM-powered memory classification
 *
 * Classifies incoming memories into PageIndex hierarchy nodes.
 * Runs async (non-blocking) with 100ms timeout — ingestion never waits.
 *
 * Flow:
 * 1. Embed memory content + node labels
 * 2. Find best-fit nodes via cosine similarity
 * 3. LLM validates classification for edge cases
 * 4. Returns node path(s) for assignment
 */

import { PageIndexService } from './pageindex-service.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const CLASSIFICATION_TIMEOUT_MS = 100;
const MIN_CONFIDENCE = 0.6;

export class PageIndexClassifier {
  constructor({ prisma, groqApiKey, logger = console }) {
    this.prisma = prisma;
    this.groqApiKey = groqApiKey || process.env.GROQ_API_KEY;
    this.logger = logger;
    this.pageIndexService = new PageIndexService({ prisma, logger });
  }

  /**
   * Classify memory and return best-fit node path(s).
   * @param {object} memory - { id, content, title, tags, userId, orgId }
   * @returns {Promise<{ paths: string[], confidence: number }>}
   */
  async classify(memory) {
    const startTime = Date.now();

    try {
      // Timeout wrapper — classification must complete within 100ms
      const result = await Promise.race([
        this._classifyWithTimeout(memory),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Classification timeout')), CLASSIFICATION_TIMEOUT_MS)
        ),
      ]);

      this.logger.log(
        `[pageindex-classifier] Classified ${memory.id.slice(0, 8)} in ${Date.now() - startTime}ms:`,
        result.paths
      );

      return result;
    } catch (err) {
      this.logger.warn('[pageindex-classifier] Classification failed:', err.message);
      // Return empty — memory will be indexed later by background job
      return { paths: [], confidence: 0 };
    }
  }

  /**
   * Async classification — fire-and-forget, doesn't block ingestion.
   * @param {object} memory
   * @returns {Promise<void>}
   */
  async classifyAsync(memory) {
    // Fire-and-forget — errors logged but not propagated
    this.classify(memory).catch(err => {
      this.logger.warn('[pageindex-classifier] Async classification failed:', err.message);
    });
  }

  /**
   * Internal classification logic with timeout.
   * @private
   */
  async _classifyWithTimeout(memory) {
    // Check if PageIndex is available
    const available = await this.pageIndexService.isAvailable();
    if (!available) {
      return { paths: [], confidence: 0 };
    }

    // Fetch all nodes for user
    const nodes = await this.pageIndexService.getTree(memory.userId);
    if (!nodes || nodes.length === 0) {
      return { paths: [], confidence: 0 };
    }

    // Flatten tree to array of { path, label, depth }
    const nodePaths = this._flattenTree(nodes);

    if (nodePaths.length === 0) {
      return { paths: [], confidence: 0 };
    }

    // Use LLM to classify
    const classification = await this._llmClassify(memory, nodePaths);

    if (classification.confidence < MIN_CONFIDENCE) {
      this.logger.log(
        `[pageindex-classifier] Low confidence (${classification.confidence}), deferring to background`
      );
      return { paths: [], confidence: classification.confidence };
    }

    return classification;
  }

  /**
   * LLM-based classification.
   * @private
   */
  async _llmClassify(memory, nodePaths) {
    if (!this.groqApiKey) {
      // Fallback to keyword-based classification
      return this._keywordClassify(memory, nodePaths);
    }

    const nodeDescriptions = nodePaths
      .map(n => `- ${n.path} (${n.label})`)
      .join('\n');

    const contentPreview = (memory.content || '').slice(0, 2000);
    const title = memory.title || 'Untitled';
    const tags = (memory.tags || []).join(', ') || 'none';

    try {
      const resp = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.groqApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: `You are a memory classification engine. Given a memory and a list of available topic paths, classify which path(s) the memory belongs to.

A memory can belong to MULTIPLE paths (cross-referencing).
Return ONLY valid JSON: { "paths": ["/path1", "/path2"], "confidence": 0.85, "reason": "brief explanation" }

Rules:
- Match content to the MOST SPECIFIC path (deepest relevant node)
- If content spans multiple topics, include all relevant paths
- Confidence: 0.0-1.0 based on how clearly the content matches
- If no path matches well, return empty paths array with low confidence`,
            },
            {
              role: 'user',
              content: `Memory to classify:
Title: ${title}
Tags: ${tags}
Content: ${contentPreview}

Available paths:
${nodeDescriptions}

Return ONLY JSON.`,
            },
          ],
          max_tokens: 300,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
      });

      if (!resp.ok) {
        throw new Error(`Groq API ${resp.status}`);
      }

      const data = await resp.json();
      const output = data.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(output);

      return {
        paths: parsed.paths || [],
        confidence: parsed.confidence || 0.5,
        reason: parsed.reason || '',
      };
    } catch (err) {
      this.logger.warn('[pageindex-classifier] LLM classification failed, using keywords:', err.message);
      return this._keywordClassify(memory, nodePaths);
    }
  }

  /**
   * Keyword-based fallback classification.
   * @private
   */
  _keywordClassify(memory, nodePaths) {
    const content = `${memory.title || ''} ${(memory.content || '').slice(0, 500)} ${(memory.tags || []).join(' ')}`.toLowerCase();

    // Tokenize content
    const tokens = content
      .split(/\W+/)
      .filter(t => t.length > 2 && !this._isStopword(t));

    // Score each node by keyword overlap
    const scored = nodePaths.map(node => {
      const labelTokens = node.label.toLowerCase().split(/\W+/).filter(t => t.length > 2);
      const pathTokens = node.path.toLowerCase().split(/\W+/).filter(t => t.length > 2);
      const allNodeTokens = new Set([...labelTokens, ...pathTokens]);

      let overlap = 0;
      for (const token of tokens) {
        if (allNodeTokens.has(token)) overlap++;
      }

      const confidence = tokens.length > 0 ? overlap / Math.min(tokens.length, 10) : 0;

      return {
        path: node.path,
        confidence: Math.min(confidence, 1.0),
        overlap,
      };
    });

    // Filter by minimum confidence
    const matched = scored
      .filter(n => n.confidence >= MIN_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3); // Max 3 paths

    return {
      paths: matched.map(n => n.path),
      confidence: matched.length > 0 ? matched[0].confidence : 0,
    };
  }

  /**
   * Flatten tree to array of paths.
   * @private
   */
  _flattenTree(nodes, results = []) {
    for (const node of nodes) {
      results.push({
        path: node.path,
        label: node.label,
        depth: node.depth,
      });
      if (node.children && node.children.length > 0) {
        this._flattenTree(node.children, results);
      }
    }
    return results;
  }

  /**
   * Check if word is a stopword.
   * @private
   */
  _isStopword(word) {
    const stopwords = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'our',
      'are', 'was', 'were', 'can', 'could', 'would', 'should', 'will', 'just',
      'about', 'what', 'when', 'where', 'why', 'how', 'they', 'them', 'their',
    ]);
    return stopwords.has(word.toLowerCase());
  }
}
