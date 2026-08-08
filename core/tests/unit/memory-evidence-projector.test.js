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
