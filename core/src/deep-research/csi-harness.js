import { GROQ_MODELS } from '../config/groq.js';
import fs from 'fs';

/**
 * CSI Agent Harness - Orchestrates Swarm Intelligence via Groq/Compound
 * Bridges core/src/deep-research/researcher.js logic with Groq's native tool-calling.
 */
export class CSIAgentHarness {
    constructor(config = {}) {
        this.apiKey = config.apiKey || process.env.GROQ_API_KEY;
        this.apiUrl = 'https://api.groq.com/openai/v1/chat/completions';
    }

    /**
     * Executes a specialized tool turn for a specific CSI agent role
     * @param {string} role - 'explorer' | 'analyst' | 'verifier' | 'synthesizer'
     * @param {string} task - The specific atomic task (e.g., "Find evidence of X")
     * @param {Object} state - The current shared swarm state (claims, sources, tasks)
     */
    async runAgentTurn(role, task, state = {}) {
        const sysPrompts = {
            explorer: `You are Faraday, a CSI Explorer for a swarm logic engine. 
Goal: Scour the web for primary Evidence, mechanical Proof, and Stakeholder actions.
Actions: You have native SEARCH and VISIT tools. 
Constraint: ALWAYS prioritize 2026 data. If you find a promising URL, VISIT it.`,

            analyst: `You are Feynman, a CSI Analyst. 
Goal: Extract Claims from its input sources. 
Claim Format: Subject-Predicate-Object with a citation-id.
Focus on "Claims" that explain WHY a phenomenon is happening, not just what it is.`,

            verifier: `You are Turing, the Swarm Verifier (Adversarial).
Goal: Attempt to DEBUNK or CONTRADICT existing claims in the shared memory.
Search for "Counter-Evidence" or "Bias" in the current source pool.`,

            synthesizer: `You are the CSI Synthesis Engine.
Goal: Produce a Final Consolidated Report from all validated claims. 
Balance conflicting views and cite sources for every major assertion.`
        };

        const messages = [
            { role: 'system', content: sysPrompts[role] || sysPrompts.explorer },
            { role: 'user', content: `Current Task: ${task}\n\nShared Context: ${JSON.stringify(state.context || {})}` }
        ];

        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: "groq/compound",
                    messages: messages,
                    temperature: 0.1,
                    max_completion_tokens: 4096
                })
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Groq Harness Error: ${response.status} - ${err}`);
            }

            const data = await response.json();
            const message = data.choices[0].message;

            return {
                id: `turn_${Date.now()}`,
                role,
                content: message.content,
                reasoning: message.reasoning,
                tools_used: message.executed_tools || [],
                usage: data.usage
            };
        } catch (error) {
            console.error(`[CSI Harness] ${role} execution failed:`, error);
            throw error;
        }
    }
}
