import { chatCompletionStream, DEFAULT_HQ_AWAKENING_MODEL } from '../llm/chat-provider.js';

function clean(value, limit = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function factsFor(company = {}) {
  const profile = company.profile && typeof company.profile === 'object' ? company.profile : {};
  return {
    name: clean(company.company || company.name || profile.name || 'this company', 120),
    website: clean(company.website || profile.website || '', 180),
    location: clean(company.location || company.city || profile.location || '', 120),
    positioning: clean(company.positioning || profile.positioning || '', 320),
    icp: clean(company.icp || profile.icp || '', 260),
  };
}

export function fallbackAwakeningNarration({ company, objective, capabilities, restart = false }) {
  const facts = factsFor(company);
  const identity = facts.website ? `${facts.name} at ${facts.website}` : facts.name;
  const place = facts.location ? ` in ${facts.location}` : '';
  const focus = clean(objective, 260) || facts.positioning || facts.icp || 'the company objective';
  const access = capabilities.length ? ` I can already use ${capabilities.slice(0, 4).join(', ')}.` : ' I will identify the evidence and access that are still missing.';
  return `${restart ? 'I am rebuilding the current position for' : 'I have come online to operate'} ${identity}${place}. The first thing that matters is an accurate reading of ${focus}, not activity for its own sake.${access}`;
}

export async function narrateAwakening({ company, objective, capabilities = [], restart = false, fallbackApiKey, onDelta = null }) {
  const fallback = fallbackAwakeningNarration({ company, objective, capabilities, restart });
  const model = process.env.HQ_AWAKENING_MODEL || DEFAULT_HQ_AWAKENING_MODEL;
  try {
    const response = await chatCompletionStream(model, {
      method: 'POST',
      body: JSON.stringify({
        temperature: 0.35,
        max_completion_tokens: 140,
        reasoning: { enabled: false, exclude: true },
        messages: [
          { role: 'system', content: 'Write a two-sentence maximum first-person HQ Runtime awakening. Use only supplied facts. It should feel freshly specific and operational, but never claim consciousness, expose hidden reasoning, or invent information. State what this company is, one real tension or unknown, and the immediate next move. No markdown or headings.' },
          { role: 'user', content: JSON.stringify({ event: restart ? 'runtime_restart' : 'first_activation', company: factsFor(company), objective: clean(objective, 700), available_capabilities: capabilities.slice(0, 12) }) },
        ],
      }),
    }, { fallbackApiKey, onContent: onDelta });
    if (!response.ok) throw new Error(`awakening_narration_failed:${response.status}`);
    const narration = clean(response.content, 900);
    return { narration: narration || fallback, model, provider: response.provider, usage: response.usage || {}, fallback: !narration };
  } catch {
    return { narration: fallback, model: null, provider: null, usage: {}, fallback: true };
  }
}
