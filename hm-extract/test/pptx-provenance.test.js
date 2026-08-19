import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { injectPptxSlideMarkers, pptxSlideTextRuns } from '../src/pptx-provenance.js';
import { stripPageMarkers } from '../src/strip-page-markers.js';

function fixture() {
  return Buffer.from(zipSync({
    'ppt/presentation.xml': strToU8('<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="rId5"/><p:sldId r:id="rId2"/></p:sldIdLst></p:presentation>'),
    'ppt/_rels/presentation.xml.rels': strToU8('<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId5" Target="slides/slide2.xml"/></Relationships>'),
    'ppt/slides/slide1.xml': strToU8('<p:sld><a:t>First slide anchor</a:t><a:t>First detail</a:t></p:sld>'),
    'ppt/slides/slide2.xml': strToU8('<p:sld><a:t>Second slide anchor</a:t><a:t>Second detail</a:t></p:sld>'),
  }));
}

test('PPTX provenance follows presentation order rather than slide filenames', () => {
  const slides = pptxSlideTextRuns(fixture());
  assert.deepEqual(slides.map((slide) => slide.runs[0]), ['Second slide anchor', 'First slide anchor']);
});

test('PPTX markers survive as exact clean-text offsets for downstream citations', () => {
  const markdown = 'Second slide anchor\nSecond detail\n\nFirst slide anchor\nFirst detail';
  const marked = injectPptxSlideMarkers(markdown, fixture());
  const stripped = stripPageMarkers(marked);
  assert.equal(stripped.text, markdown);
  assert.deepEqual(stripped.marks.map((mark) => mark.page), [1, 2]);
  assert.equal(stripped.text.slice(stripped.marks[0].at).startsWith('Second slide anchor'), true);
  assert.equal(stripped.text.slice(stripped.marks[1].at).startsWith('First slide anchor'), true);
});

test('unresolvable slides never fabricate page numbers', () => {
  assert.equal(injectPptxSlideMarkers('unrelated markdown', fixture()), 'unrelated markdown');
});
