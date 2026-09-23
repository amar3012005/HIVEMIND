import test from 'node:test';
import assert from 'node:assert/strict';
import { projectHmUnderstandWindow } from '../../src/knowledge/enterprise/hm-understand-assisted.js';
import { DocumentFirstIngestionService, normalizeUnifiedClaims } from '../../src/knowledge/document-first-ingestion.js';

function candidate(quote, signals = ['decision_verb']) {
  return { kind: 'decision', signals, evidence: { quote } };
}

test('assisted projection keeps grounded high-signal sentences and validates offsets against original text', () => {
  const content = 'Background information with no named entity and no measurable fact. '
    + 'Project Atlas status: approved. The board approved a 12000 EUR budget for Project Atlas. '
    + 'This paragraph explains background without naming a project or reporting a measurable fact.';
  const analysis = {
    complete: true,
    blocks: [{ language: { primary: 'en' }, quality: { refinement_required: false },
      mentions: [{ text: 'Project Atlas', label: 'project', extractor: 'gliner' }],
      candidates: [candidate('Project Atlas status: approved.'),
        candidate('The board approved a 12000 EUR budget for Project Atlas.')],
    }],
  };
  const result = projectHmUnderstandWindow({ content }, analysis);
  assert.ok(result);
  assert.equal(result.sourceContent, content);
  assert.equal(result.extractionContent,
    'Project Atlas status: approved.\nThe board approved a 12000 EUR budget for Project Atlas.');
  assert.ok(result.savingsRatio >= 0.15);
  const claim = normalizeUnifiedClaims([{ t: 'Project Atlas', f: 'Project Atlas status is approved.',
    memory_type: 'fact', source_quote: 'Project Atlas status: approved.', subject: 'Project Atlas', entities: [] }],
  result.sourceContent, 1)[0];
  assert.ok(claim.source_start > 0);
  assert.equal(result.sourceContent.slice(claim.source_start, claim.source_end), claim.source_quote);
});

test('assisted projection falls back when any heuristic fact-bearing sentence is uncovered', () => {
  const content = 'Project Atlas status: approved. The board approved a 12000 EUR budget for Project Atlas.';
  const analysis = { complete: true, blocks: [{ language: { primary: 'en' }, quality: { refinement_required: false },
    mentions: [{ text: 'Project Atlas', label: 'project', extractor: 'gliner' }],
    candidates: [candidate('Project Atlas status: approved.')],
  }] };
  assert.equal(projectHmUnderstandWindow({ content }, analysis), null);
});

test('assisted projection fails open to full source for uncertain or unvalidated analysis', () => {
  const content = 'Project Atlas status: approved. The board approved a 12000 EUR budget for Project Atlas. '
    + 'This paragraph explains background without naming a project or reporting a measurable fact.';
  const analysis = { complete: true, blocks: [{ language: { primary: 'hi' },
    quality: { refinement_required: true }, mentions: [], candidates: [candidate(content.split(' This ')[0])],
  }] };
  assert.equal(projectHmUnderstandWindow({ content }, analysis), null);
  assert.equal(projectHmUnderstandWindow({ content }, { ...analysis, complete: false }), null);
});

test('existing unified LLM call receives compact text but validates quotes against the original window', async () => {
  const sourceContent = 'Background information with no named entity and no measurable fact. '
    + 'Project Atlas status: approved after board review. This paragraph gives additional unselected context.';
  const extractionContent = 'Project Atlas status: approved after board review.';
  let llmRequest;
  const observedUsage = [];
  const service = new DocumentFirstIngestionService({
    db: null, smartIngestRouter: null, memoryGraphEngine: null, doclingAdapter: null, embeddingService: null,
    llmCompletion: async (request) => {
      llmRequest = request;
      request.onUsage?.({ prompt_tokens: 321, completion_tokens: 45, total_tokens: 366, model: 'fixture-model' });
      return { facts: [{ t: 'Project Atlas', f: 'Project Atlas status is approved.', memory_type: 'fact',
        source_quote: 'Project Atlas status: approved after board review.', subject: 'Project Atlas', entities: [] }] };
    },
    logger: { info() {}, warn() {} },
  });
  const claims = await service._extractUnified({ content: sourceContent, extractionContent, sourceContent,
    onUsage: (usage) => observedUsage.push(usage) }, { maxFacts: 3 });
  const submittedText = llmRequest.messages.find((message) => message.role === 'user').content;
  assert.ok(submittedText.includes(extractionContent));
  assert.equal(submittedText.includes('Background information'), false);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].source_start, sourceContent.indexOf(claims[0].source_quote));
  assert.equal(sourceContent.slice(claims[0].source_start, claims[0].source_end), claims[0].source_quote);
  assert.deepEqual(observedUsage, [{ prompt_tokens: 321, completion_tokens: 45, total_tokens: 366, model: 'fixture-model' }]);
});
