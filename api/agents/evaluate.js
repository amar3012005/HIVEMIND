/**
 * POST /api/agents/evaluate
 *
 * Stores agent response evaluation in the archive.
 * This is the foundation of the improvement loop:
 *   Evaluation → Archive → Meta-agent analysis → Variant proposal → A/B test
 *
 * Request body:
 * {
 *   agent_id: string,
 *   agent_name: string,
 *   task_id: string,
 *   response_text: string,
 *   rating: 1-5,
 *   feedback_text: string,
 *   evaluated_at: ISO string
 * }
 *
 * Response:
 * {
 *   evaluation_id: string,
 *   score: number (0-1),
 *   improvement_opportunity: string,
 *   avg_score: number (agent's current average)
 * }
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const ARCHIVE_DIR = path.join(__dirname, '../../archive/evaluations');
const MEMORY_DIR = path.join(__dirname, '../../memory');

// Normalize rating (1-5) to score (0-1)
const normalizeScore = (rating) => {
  return (rating - 1) / 4;
};

// Parse feedback for improvement opportunities
const extractImprovementOpportunities = (feedback) => {
  const opportunities = [];

  if (!feedback || feedback.length === 0) {
    return ['Add more context', 'Improve clarity', 'Be more concise'];
  }

  // Simple keyword extraction
  const keywords = {
    verbose: 'Shorten responses',
    too_short: 'Provide more detail',
    unclear: 'Improve clarity',
    missed: 'Address all points',
    wrong: 'Verify accuracy',
    slow: 'Improve response time',
    rambling: 'Stay focused',
    technical: 'Simplify explanation',
    evidence: 'Add supporting examples',
  };

  for (const [keyword, opportunity] of Object.entries(keywords)) {
    if (feedback.toLowerCase().includes(keyword)) {
      opportunities.push(opportunity);
    }
  }

  return opportunities.length > 0 ? opportunities : ['Review and improve'];
};

const computeAgentMetrics = async (agentId) => {
  try {
    // Read all evaluations for this agent
    const files = await fs.readdir(ARCHIVE_DIR);
    const agentEvals = [];

    for (const file of files) {
      if (file.includes(agentId)) {
        const content = await fs.readFile(
          path.join(ARCHIVE_DIR, file),
          'utf-8'
        );
        const eval = JSON.parse(content);
        agentEvals.push(eval);
      }
    }

    if (agentEvals.length === 0) {
      return { avg_score: 0, eval_count: 0, improvement_rate: 0 };
    }

    const avg_score = agentEvals.reduce((sum, e) => sum + e.score, 0) / agentEvals.length;
    const eval_count = agentEvals.length;

    // Compute improvement rate (comparing last 3 to first 3)
    let improvement_rate = 0;
    if (eval_count >= 6) {
      const first3 = agentEvals.slice(0, 3);
      const last3 = agentEvals.slice(-3);
      const first_avg = first3.reduce((sum, e) => sum + e.score, 0) / 3;
      const last_avg = last3.reduce((sum, e) => sum + e.score, 0) / 3;
      improvement_rate = last_avg > first_avg ? (last_avg - first_avg) / first_avg : 0;
    }

    return { avg_score, eval_count, improvement_rate };
  } catch (err) {
    console.error('Error computing agent metrics:', err);
    return { avg_score: 0, eval_count: 0, improvement_rate: 0 };
  }
};

const saveEvaluationToMemory = async (agentId, agentName, evaluation) => {
  try {
    // Create MEMORY.md entry
    const memoryEntry = `
- [Evaluation: ${agentName} - ${evaluation.task_id}](archive/evaluations/${evaluation.evaluation_id}.json) — Rating: ${evaluation.rating}/5, Score: ${(evaluation.score * 100).toFixed(0)}%
`;

    const memoryPath = path.join(MEMORY_DIR, 'MEMORY.md');
    let content = '';

    try {
      content = await fs.readFile(memoryPath, 'utf-8');
    } catch {
      // File doesn't exist yet
      content = '# HIVE-MIND Memory Index\n\n';
    }

    // Insert under "Evaluations" section
    if (!content.includes('## Evaluations')) {
      content += '\n## Evaluations\n';
    }

    const lines = content.split('\n');
    const evalIndex = lines.findIndex(l => l === '## Evaluations');
    if (evalIndex !== -1) {
      lines.splice(evalIndex + 1, 0, memoryEntry);
      content = lines.join('\n');
    }

    await fs.writeFile(memoryPath, content);
  } catch (err) {
    console.error('Error saving to memory:', err);
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      agent_id,
      agent_name,
      task_id,
      response_text,
      rating,
      feedback_text,
      evaluated_at,
    } = req.body;

    // Validate input
    if (!agent_id || !task_id || rating === null || rating === undefined) {
      return res.status(400).json({
        error: 'Missing required fields: agent_id, task_id, rating',
      });
    }

    if (rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return res.status(400).json({
        error: 'Rating must be an integer between 1 and 5',
      });
    }

    // Create evaluation record
    const evaluation_id = crypto.randomUUID();
    const score = normalizeScore(rating);
    const improvement_opportunities = extractImprovementOpportunities(feedback_text);

    const evaluation = {
      evaluation_id,
      agent_id,
      agent_name,
      task_id,
      rating,
      score,
      feedback_text: feedback_text || '',
      improvement_opportunities,
      response_snippet: response_text.substring(0, 200),
      evaluated_at: evaluated_at || new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    // Ensure archive directory exists
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });

    // Save evaluation to disk
    const evalPath = path.join(ARCHIVE_DIR, `${evaluation_id}.json`);
    await fs.writeFile(evalPath, JSON.stringify(evaluation, null, 2));

    // Save to agent-specific file (for easier bulk queries)
    const agentEvalPath = path.join(
      ARCHIVE_DIR,
      `${agent_id}_evals.jsonl`
    );
    let agentContent = '';
    try {
      agentContent = await fs.readFile(agentEvalPath, 'utf-8');
    } catch {
      // New file
    }
    await fs.appendFile(agentEvalPath, JSON.stringify(evaluation) + '\n');

    // Compute current agent metrics
    const metrics = await computeAgentMetrics(agent_id);

    // Save to HIVE-MIND memory
    await saveEvaluationToMemory(agent_id, agent_name, evaluation);

    // Return response
    return res.status(201).json({
      evaluation_id,
      score,
      improvement_opportunity: improvement_opportunities[0],
      avg_score: metrics.avg_score,
      eval_count: metrics.eval_count,
      improvement_rate: metrics.improvement_rate,
      message: `Evaluation saved. ${agent_name}'s avg score: ${(metrics.avg_score * 100).toFixed(0)}%`,
    });

  } catch (error) {
    console.error('Evaluation error:', error);
    return res.status(500).json({
      error: 'Failed to save evaluation',
      details: error.message,
    });
  }
}
