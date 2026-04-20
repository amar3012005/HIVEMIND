import fs from 'fs';
import path from 'path';

/**
 * CSI Agent Harness for Groq/Compound
 * Wraps HIVE-MIND CSI Agents (Faraday/Analyst/Verifier) into 
 * Groq's native tool-calling environment for 3x faster research loops.
 */
class CSIGroqHarness {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.apiUrl = 'https://api.groq.com/openai/v1/chat/completions';
    }

    /**
     * Executes a CSI Agent Turn
     * @param {string} role - 'explorer' | 'analyst' | 'verifier'
     * @param {string} goal - The specific research objective
     * @param {Array} context - Previous findings/messages
     */
    async executeTurn(role, goal, context = []) {
        const systemPrompts = {
            explorer: "You are Faraday, a CSI Explorer. Your goal is to gather diverse, high-quality sources. Use the search tool to find evidence, mechanisms, and stakeholders. Look for specific claims to extract later.",
            analyst: "You are Feynman, a CSI Analyst. Your goal is to extract core claims (Subject-Predicate-Object) from provided context. Be precise and cite your sources.",
            verifier: "You are Turing, a CSI Verifier. Your goal is to cross-check claims for contradictions or bias. Use the search tool to verify specific assertions."
        };

        console.log(`\n[CSI HARNESS] Scaling ${role.toUpperCase()} agent for goal: ${goal.slice(0, 50)}...`);

        const messages = [
            { role: 'system', content: systemPrompts[role] || systemPrompts.explorer },
            ...context,
            { role: 'user', content: `Current Task: ${goal}` }
        ];

        const startTime = Date.now();
        const response = await fetch(this.apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "groq/compound",
                messages: messages,
                temperature: 0.1, // Low temp for research accuracy
                max_completion_tokens: 3000
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Groq Harness Error: ${response.status} - ${err}`);
        }

        const data = await response.json();
        const duration = Date.now() - startTime;
        
        // --- TOKEN & PERFORMANCE METRICS ---
        const usage = data.usage || {};
        const message = data.choices[0].message;
        
        return {
            role,
            content: message.content,
            reasoning: message.reasoning,
            tools_executed: message.executed_tools || [],
            metrics: {
                duration_ms: duration,
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                total_tokens: usage.total_tokens,
                queue_time: usage.queue_time || 0
            }
        };
    }
}

// --- QUICK HARNESS TEST ---
async function main() {
    const envPath = path.join(process.cwd(), 'core', '.env');
    const envData = fs.readFileSync(envPath, 'utf-8');
    const apiKey = envData.match(/GROQ_API_KEY\s*=\s*(.*)/)?.[1]?.trim();

    if (!apiKey) return console.error("No GROQ_API_KEY found");

    const harness = new CSIGroqHarness(apiKey);
    
    // Test a "Faraday" (Explorer) turn
    const result = await harness.executeTurn(
        'explorer', 
        "Find evidence of Blackwell architecture overheating issues in early 2026 data center deployments."
    );

    console.log("\n=== CSI HARNESS TURN SUMMARY ===");
    console.log(`Agent: ${result.role}`);
    console.log(`Total Tokens: ${result.metrics.total_tokens}`);
    console.log(`Completion Tokens: ${result.metrics.completion_tokens}`);
    console.log(`Latency: ${result.metrics.duration_ms}ms`);
    console.log(`Tools Used: ${result.tools_executed.length}`);
    
    if (result.tools_executed.length > 0) {
        console.log(`First Tool Search Results: ${result.tools_executed[0].search_results?.results?.length || 0}`);
    }

    console.log("\n[AGENT REASONING SAMPLE]:");
    console.log(result.reasoning.split('\n')[0] + "...");
}

main();
