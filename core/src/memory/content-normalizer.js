/**
 * ContentNormalizer
 *
 * Source-type-aware content cleanup and metadata extraction.
 * Runs BEFORE embedding/storage to maximize signal-to-noise ratio.
 *
 * Each normalizer returns: { content: string, metadata: object }
 */

export class ContentNormalizer {

  /**
   * Normalize content based on detected source type.
   * @param {string} content - raw content
   * @param {string} sourceType - detected source type (gmail, claude, notion, github, slack, manual)
   * @param {object} metadata - existing metadata
   * @returns {{ content: string, metadata: object }}
   */
  normalize(content, sourceType, metadata = {}) {
    if (!content || typeof content !== 'string') return { content: content || '', metadata };

    let result;
    switch (sourceType) {
      case 'gmail': result = this._normalizeEmail(content, metadata); break;
      case 'claude': result = this._normalizeClaude(content, metadata); break;
      case 'knowledge_base': result = this._normalizeDocument(content, metadata); break;
      case 'github': result = this._normalizeCode(content, metadata); break;
      case 'slack': result = this._normalizeChat(content, metadata); break;
      default: result = this._normalizeGeneral(content, metadata); break;
    }

    // Universal cleanup
    result.content = this._universalCleanup(result.content);
    return result;
  }

  // ========= Email Normalization =========
  _normalizeEmail(content, metadata) {
    let cleaned = content;

    // Remove quoted replies
    cleaned = cleaned.replace(/^>.*$/gm, '');
    cleaned = cleaned.replace(/On\s+.{10,80}\s+wrote:\s*$/gm, '');

    // Remove forwarded message headers
    cleaned = cleaned.replace(/-{5,}\s*Forwarded message\s*-{5,}[\s\S]*?(?=\n\n)/gi, '');

    // Remove signatures
    cleaned = cleaned.replace(/\n--\s*\n[\s\S]*$/m, '');
    cleaned = cleaned.replace(/\n(Best regards|Kind regards|Regards|Thanks|Cheers|Sent from my|Get Outlook),?[\s\S]*$/mi, '');

    // Remove legal disclaimers
    cleaned = cleaned.replace(/\n(DISCLAIMER|CONFIDENTIALITY|This email and any|This message is intended)[\s\S]*$/mi, '');

    // Extract email addresses
    const emailPattern = /[\w.+-]+@[\w.-]+\.\w{2,}/g;
    const emails = content.match(emailPattern) || [];

    return {
      content: cleaned,
      metadata: {
        ...metadata,
        _normalized: true,
        _normalizer: 'email',
        _extracted_emails: emails,
        _original_length: content.length,
        _cleaned_length: cleaned.length,
      }
    };
  }

  // ========= Claude Conversation Normalization =========
  _normalizeClaude(content, metadata) {
    let cleaned = content;

    // Remove system messages
    cleaned = cleaned.replace(/^system:[\s\S]*?(?=\n(?:user|human|assistant):)/gim, '');

    // Remove tool_use / tool_result blocks
    cleaned = cleaned.replace(/```(?:json|xml)?\s*\{[\s\S]*?"type"\s*:\s*"tool_(?:use|result)"[\s\S]*?```/g, '');

    // Extract decisions and preferences
    const decisionLines = [];
    const lines = cleaned.split('\n');
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (
        lower.includes('decided') || lower.includes('chose') || lower.includes('prefer') ||
        lower.includes('will use') || lower.includes('going with') || lower.includes('switched to') ||
        lower.includes('important:') || lower.includes('remember:') || lower.includes('note:') ||
        lower.includes('always ') || lower.includes('never ') || lower.includes('must ')
      ) {
        decisionLines.push(line.trim());
      }
    }

    return {
      content: cleaned,
      metadata: {
        ...metadata,
        _normalized: true,
        _normalizer: 'claude',
        _decision_count: decisionLines.length,
        _decisions: decisionLines.slice(0, 10),
      }
    };
  }

  // ========= Document / Knowledge Base Normalization =========
  _normalizeDocument(content, metadata) {
    let cleaned = content;

    // Remove page numbers
    cleaned = cleaned.replace(/\n\s*(?:Page\s+\d+(?:\s+of\s+\d+)?|-\s*\d+\s*-)\s*\n/gi, '\n');

    // Remove repeated separator lines
    cleaned = cleaned.replace(/[=]{5,}/g, '');
    cleaned = cleaned.replace(/[-]{10,}/g, '---');

    // Normalize markdown headings (ensure space after #)
    cleaned = cleaned.replace(/^(#{1,6})([^\s#])/gm, '$1 $2');

    // Extract heading structure for TOC
    const headings = [];
    const headingRe = /^(#{1,6})\s+(.+)$/gm;
    let match;
    while ((match = headingRe.exec(cleaned)) !== null) {
      headings.push({ level: match[1].length, text: match[2].trim() });
    }

    return {
      content: cleaned,
      metadata: {
        ...metadata,
        _normalized: true,
        _normalizer: 'document',
        _headings: headings.slice(0, 20),
        _heading_count: headings.length,
      }
    };
  }

  // ========= Code / GitHub Normalization =========
  _normalizeCode(content, metadata) {
    let cleaned = content;

    // Detect if this is a PR/issue vs raw code
    const isPR = /^(Title|PR|Pull Request|Issue|Merge Request):?\s/mi.test(content);

    if (!isPR) {
      // Raw code: strip block comments but keep single-line comments
      cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
      cleaned = cleaned.replace(/"""\s*[\s\S]*?"""/g, '');
      cleaned = cleaned.replace(/'''\s*[\s\S]*?'''/g, '');
    }

    // Extract function/class names
    const definitions = [];
    const funcRe = /(?:function|def|fn|func|async\s+function)\s+(\w+)/g;
    const classRe = /(?:class|struct|interface|type)\s+(\w+)/g;
    let m;
    while ((m = funcRe.exec(content)) !== null) definitions.push({ type: 'function', name: m[1] });
    while ((m = classRe.exec(content)) !== null) definitions.push({ type: 'class', name: m[1] });

    return {
      content: cleaned,
      metadata: {
        ...metadata,
        _normalized: true,
        _normalizer: 'code',
        _is_pr: isPR,
        _definitions: definitions.slice(0, 30),
      }
    };
  }

  // ========= Chat / Slack Normalization =========
  _normalizeChat(content, metadata) {
    let cleaned = content;

    // Remove bot/system messages
    cleaned = cleaned.replace(/^\[?\w+\s+(?:joined|left|has joined|has left|set the topic|pinned a message).*$/gm, '');

    // Remove reaction-only lines
    cleaned = cleaned.replace(/^:[\w+-]+:\s*$/gm, '');

    // Extract action items
    const actionItems = [];
    const lines = cleaned.split('\n');
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.includes('todo') || lower.includes('action item') || lower.includes('follow up') || /@\w+/.test(line)) {
        actionItems.push(line.trim());
      }
    }

    return {
      content: cleaned,
      metadata: {
        ...metadata,
        _normalized: true,
        _normalizer: 'chat',
        _action_items: actionItems.slice(0, 10),
      }
    };
  }

  // ========= General / Manual Normalization =========
  _normalizeGeneral(content, metadata) {
    return {
      content,
      metadata: {
        ...metadata,
        _normalized: true,
        _normalizer: 'general',
      }
    };
  }

  // ========= Universal Cleanup =========
  _universalCleanup(content) {
    if (!content) return '';

    let cleaned = content;

    // Collapse 3+ consecutive newlines to 2
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // Trim trailing whitespace on each line
    cleaned = cleaned.replace(/[^\S\n]+$/gm, '');

    // Remove null bytes and control characters (except newline, tab)
    cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // Collapse multiple spaces/tabs to single space (but preserve leading whitespace for code)
    cleaned = cleaned.replace(/([^\n\S]){2,}/g, (match, char, offset, str) => {
      const lineStart = str.lastIndexOf('\n', offset) + 1;
      if (offset === lineStart) return match; // preserve indentation
      return ' ';
    });

    return cleaned.trim();
  }
}
