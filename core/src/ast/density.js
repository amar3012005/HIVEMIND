/**
 * NWS (Non-Whitespace) Density Calculator
 * Measures logic density for better chunk quality
 */

/**
 * NWS Density Calculator class
 */
export class NWSDensityCalculator {
  constructor() {
    this.minDensity = 0.3; // Minimum acceptable density
    this.maxChunkSize = 1500; // Characters
  }

  /**
   * Calculate NWS density for text
   * @param {string} text - Text to analyze
   * @returns {Object} Density metrics
   */
  calculateDensity(text) {
    const totalChars = text.length;
    const whitespaceChars = (text.match(/\s/g) || []).length;
    const nonWhitespaceChars = totalChars - whitespaceChars;
    const density = totalChars > 0 ? nonWhitespaceChars / totalChars : 0;

    return {
      totalChars,
      whitespaceChars,
      nonWhitespaceChars,
      density,
      isAcceptable: density >= this.minDensity
    };
  }

  /**
   * Calculate density for AST node
   * @param {Object} node - AST node
   * @param {string} code - Source code
   * @returns {Object} Density metrics
   */
  calculateNodeDensity(node, code) {
    const nodeText = code.substring(node.startIndex, node.endIndex);
    return this.calculateDensity(nodeText);
  }

  /**
   * Calculate density for chunk
   * @param {Object} chunk - Chunk object with text property
   * @returns {Object} Density metrics
   */
  calculateChunkDensity(chunk) {
    return this.calculateDensity(chunk.text);
  }

  /**
   * Score chunk based on density and size
   * @param {Object} chunk - Chunk object
   * @returns {number} Score between 0 and 1
   */
  scoreChunk(chunk) {
    const density = this.calculateChunkDensity(chunk);
    const sizeScore = Math.min(chunk.text.length / this.maxChunkSize, 1);
    const densityScore = density.density;

    // Weighted combination: 40% size, 60% density
    return 0.4 * sizeScore + 0.6 * densityScore;
  }

  /**
   * Filter chunks by minimum density
   * @param {Array} chunks - Array of chunk objects
   * @param {number} minDensity - Minimum density threshold
   * @returns {Array} Filtered chunks
   */
  filterByDensity(chunks, minDensity = 0.3) {
    return chunks.filter(chunk =>
      this.calculateChunkDensity(chunk).density >= minDensity
    );
  }

  /**
   * Merge small chunks to improve density
   * @param {Array} chunks - Array of chunk objects
   * @param {number} minDensity - Minimum density threshold
   * @returns {Array} Merged chunks
   */
  mergeSmallChunks(chunks, minDensity = 0.3) {
    const merged = [];
    let currentChunk = { text: '', start: 0, end: 0 };

    for (const chunk of chunks) {
      const testChunk = {
        text: currentChunk.text + (currentChunk.text ? '\n' : '') + chunk.text,
        start: currentChunk.start,
        end: chunk.end
      };

      const density = this.calculateChunkDensity(testChunk);

      // Check if adding node would exceed limits
      const wouldExceedSize = testChunk.text.length > this.maxChunkSize;
      const wouldExceedOverlap = currentChunk.text.length > 0 &&
        testChunk.text.length - currentChunk.text.length > 100;

      if (wouldExceedSize || wouldExceedOverlap) {
        // Finalize current chunk
        if (currentChunk.text.length > 0) {
          merged.push(currentChunk);
        }
        currentChunk = { ...chunk };
      } else {
        // Add node to current chunk
        currentChunk = testChunk;
      }
    }

    // Add final chunk
    if (currentChunk.text.length > 0) {
      merged.push(currentChunk);
    }

    return merged;
  }

  /**
   * Get density statistics for array of chunks
   * @param {Array} chunks - Array of chunk objects
   * @returns {Object} Statistics object
   */
  getDensityStats(chunks) {
    const densities = chunks.map(c => this.calculateChunkDensity(c).density);

    return {
      min: Math.min(...densities),
      max: Math.max(...densities),
      avg: densities.reduce((a, b) => a + b, 0) / densities.length,
      median: this._median(densities),
      count: chunks.length
    };
  }

  /**
   * Calculate median of values
   * @param {Array} values - Array of numbers
   * @returns {number} Median value
   */
  _median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  /**
   * Calculate NWS density for a specific range in code
   * @param {string} code - Source code
   * @param {number} start - Start position
   * @param {number} end - End position
   * @returns {Object} Density metrics
   */
  calculateRangeDensity(code, start, end) {
    const text = code.substring(start, end);
    return this.calculateDensity(text);
  }

  /**
   * Check if text meets minimum density threshold
   * @param {string} text - Text to check
   * @param {number} minDensity - Minimum density threshold
   * @returns {boolean} True if density meets threshold
   */
  meetsThreshold(text, minDensity = 0.3) {
    return this.calculateDensity(text).density >= minDensity;
  }

  /**
   * Calculate density for multiple chunks in batch
   * @param {Array} chunks - Array of chunk objects
   * @returns {Array} Array of density metrics
   */
  batchCalculateDensity(chunks) {
    return chunks.map(chunk => this.calculateChunkDensity(chunk));
  }
}

// Singleton instance
let nwsCalculator = null;

/**
 * Get singleton NWSCalculator instance
 * @returns {NWSCalculator} NWS calculator instance
 */
export function getNWSCalculator() {
  if (!nwsCalculator) {
    nwsCalculator = new NWSDensityCalculator();
  }
  return nwsCalculator;
}
