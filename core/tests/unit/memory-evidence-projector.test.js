import test from 'node:test';
import assert from 'node:assert/strict';

test('projects a semantically relevant late detail from the complete ranked memory within budget', async () => {
  const projector = await import('../../src/agent/memory-evidence-projector.js').catch(() => ({}));
  assert.equal(typeof projector.projectRankedMemoryEvidence, 'function');

  const filler = Array.from({ length: 30 }, (_, index) =>
    `Section ${index + 1}\nGeneral product presentation detail ${index + 1}.`,
  ).join('\n\n');
  const memory = {
    id: 'memory-1',
    title: 'IMG-20260807-WA0001.jpg',
    content: `${filler}\n\nBranding and identifiers\nThe associated maker is G ROCHER. The visible name may be partially cropped, so the complete name could be longer.`,
    tags: ['image', 'entity:handbag', 'entity:g-rocher'],
  };

  const embed = async (texts) => texts.map((text) => {
    const value = String(text);
    const semanticallyAboutMaker = value.includes('ブランド')
      || value.includes('associated maker')
      || value.includes('entity:g-rocher');
    return semanticallyAboutMaker ? [1, 0] : [0, 1];
  });

  const [result] = await projector.projectRankedMemoryEvidence({
    query: 'このハンドバッグのブランドは何ですか？',
    memories: [memory],
    perMemoryBudget: 420,
    embed,
  });

  assert.match(result.excerpt, /G ROCHER/);
  assert.match(result.excerpt, /partially cropped/);
  assert.match(result.tags.join(' '), /entity:g-rocher/);
  assert.ok(result.excerpt.length <= 420);
});

test('does not truncate a relevant detail at the end of a long unstructured passage', async () => {
  const projector = await import('../../src/agent/memory-evidence-projector.js');
  const memory = {
    id: 'memory-2',
    title: 'Operations note',
    content: `${'Routine operational context. '.repeat(80)}The recovery code is ZX-91-Q. Do not use the retired code ZX-10.`,
    tags: ['operations'],
  };
  const embed = async (texts) => texts.map((text) => {
    const value = String(text);
    return value.includes('رمز الاسترداد') || value.includes('ZX-91-Q') ? [1, 0] : [0, 1];
  });

  const [result] = await projector.projectRankedMemoryEvidence({
    query: 'ما هو رمز الاسترداد؟',
    memories: [memory],
    perMemoryBudget: 260,
    embed,
  });

  assert.match(result.excerpt, /ZX-91-Q/);
  assert.match(result.excerpt, /retired code ZX-10/);
  assert.ok(result.excerpt.length <= 260);
});

test('keeps competing high-relevance identifiers so synthesis can distinguish them', async () => {
  const projector = await import('../../src/agent/memory-evidence-projector.js');
  const memory = {
    id: 'memory-3',
    title: 'Equipment record',
    content: [
      `Display markings\nThe device face shows the identifier AB-14. ${'Visual description. '.repeat(6)}`,
      `General context\n${'Routine background information. '.repeat(7)}`,
      `Supplier record\nThe associated supplier is Zeta Works. AB-14 is the device identifier, not the supplier.`,
    ].join('\n\n'),
    tags: ['entity:ab-14', 'entity:zeta-works'],
  };
  const embed = async (texts) => texts.map((text) => {
    const value = String(text);
    return value.includes('Lieferant') || value.includes('AB-14') || value.includes('Zeta Works')
      ? [1, 0]
      : [0, 1];
  });

  const [result] = await projector.projectRankedMemoryEvidence({
    query: 'Wer ist der Lieferant dieses Geräts?',
    memories: [memory],
    perMemoryBudget: 420,
    embed,
  });

  assert.match(result.excerpt, /AB-14/);
  assert.match(result.excerpt, /associated supplier is Zeta Works/);
  assert.match(result.excerpt, /not the supplier/);
  assert.ok(result.excerpt.length <= 420);
});

test('degraded projection preserves a buried detail in the complete top-ranked memory', async () => {
  const projector = await import('../../src/agent/memory-evidence-projector.js');
  const buried = 'The associated brand is G ROCHER.';
  const content = `${'overview '.repeat(420)}\n${buried}`;
  const projected = projector.projectRankedMemoryFallback([
    { id: 'top', content, tags: ['entity:handbag'] },
    { id: 'lower', content: 'lower-ranked context' },
  ]);

  assert.equal(projected[0].excerpt, content);
  assert.match(projected[0].excerpt, /G ROCHER/);
  assert.equal(projected[0].projection, 'rank-preserving-fallback');
});

test('degraded projection uses remaining global budget to keep short lower-ranked records complete', async () => {
  const projector = await import('../../src/agent/memory-evidence-projector.js');
  const lateDetail = 'Late qualifier: retention is nine months; manager is ليلى منصور.';
  const tailContent = `${'context '.repeat(42)}${lateDetail}`;
  const projected = projector.projectRankedMemoryFallback([
    { id: 'top', content: 'Top product fact.' },
    { id: 'tail-a', content: tailContent },
    { id: 'tail-b', content: 'Another compact supporting fact.' },
  ], { totalBudget: 1200, lowerRankBudget: 120 });

  assert.equal(projected[1].excerpt, tailContent);
  assert.match(projected[1].excerpt, /nine months/);
  assert.match(projected[1].excerpt, /ليلى منصور/);
  assert.ok(projected.reduce((sum, item) => sum + item.excerpt.length, 0) <= 1200);
});

test('adaptive projection gives the complete fitting rank-one record to synthesis', async () => {
  const projector = await import('../../src/agent/memory-evidence-projector.js');
  const topContent = `${'Context. '.repeat(90)}Late decisive detail: G ROCHER.`;
  const projected = await projector.projectAdaptiveRankedMemoryEvidence({
    query: 'What brand is the handbag?',
    memories: [
      { id: 'top', content: topContent, tags: ['entity:handbag'] },
      { id: 'tail', content: 'Unrelated lower-ranked row.', tags: [] },
    ],
    totalBudget: 3000,
    lowerRankBudget: 250,
    embed: async (texts) => texts.map(() => [1, 0]),
  });

  assert.equal(projected[0].excerpt, topContent);
  assert.equal(projected[0].projection, 'complete-rank-one');
  assert.ok(projected[1].excerpt.length <= 250);
  assert.ok(projected.reduce((sum, item) => sum + item.excerpt.length, 0) <= 3000);
});

test('adaptive projection reserves the remaining global budget across lower-ranked memories', async () => {
  const projector = await import('../../src/agent/memory-evidence-projector.js');
  const projected = await projector.projectAdaptiveRankedMemoryEvidence({
    query: 'specific detail',
    memories: [
      { id: 'top', content: 'A'.repeat(1800), tags: [] },
      { id: 'second', content: `specific detail ${'B'.repeat(1000)}`, tags: [] },
      { id: 'third', content: `specific detail ${'C'.repeat(1000)}`, tags: [] },
    ],
    totalBudget: 2400,
    lowerRankBudget: 700,
    embed: async (texts) => texts.map(() => [1, 0]),
  });

  assert.equal(projected[0].excerpt.length, 1800);
  assert.ok(projected.reduce((sum, item) => sum + item.excerpt.length, 0) <= 2400);
});

test('adaptive projection enforces one global budget when rank one itself needs semantic projection', async () => {
  const projector = await import('../../src/agent/memory-evidence-projector.js');
  const projected = await projector.projectAdaptiveRankedMemoryEvidence({
    query: 'buried detail',
    memories: [1, 2, 3, 4].map((index) => ({ id: `m${index}`, content: `buried detail ${String(index).repeat(4000)}`, tags: [] })),
    totalBudget: 1200,
    lowerRankBudget: 700,
    embed: async (texts) => texts.map(() => [1, 0]),
  });
  assert.ok(projected.reduce((sum, item) => sum + item.excerpt.length, 0) <= 1200);
});
