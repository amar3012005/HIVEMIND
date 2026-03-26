import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from '../../src/memory/observer.js';

describe('Observer.observe()', () => {
  const observer = new Observer();

  it('compresses a conversation turn into an observation containing the key fact', async () => {
    const content = `User: I graduated from MIT in 2015 with a degree in computer science.
Assistant: That's great! MIT is an excellent school. What did you focus on during your studies?
User: I focused mainly on machine learning and distributed systems.
Assistant: Those are very valuable skills in today's market.`;

    const result = await observer.observe({ content });
    assert.ok(result.observation !== null, 'observation should not be null');
    const obs = result.observation.toLowerCase();
    assert.ok(
      obs.includes('graduated') || obs.includes('mit') || obs.includes('computer science'),
      `Expected key fact in observation, got: ${result.observation}`
    );
  });

  it('assigns HIGH priority to factual user info ("My commute is 45 minutes")', async () => {
    const content = 'User: My commute is 45 minutes each way by train.';
    const result = await observer.observe({ content });
    assert.equal(result.priority, 'HIGH', `Expected HIGH priority, got: ${result.priority}`);
  });

  it('assigns LOW priority to casual/joke content ("Can you tell me a joke?")', async () => {
    const content = 'User: Can you tell me a joke? I need a laugh today.';
    const result = await observer.observe({ content });
    assert.equal(result.priority, 'LOW', `Expected LOW priority, got: ${result.priority}`);
  });

  it('extracts referenced date from "June 15, 2021"', async () => {
    const content = 'User: I started my current job on June 15, 2021 and I love it.';
    const result = await observer.observe({ content });
    assert.ok(result.referencedDate !== null, 'referencedDate should not be null');
    assert.ok(
      result.referencedDate.includes('June 15') || result.referencedDate.includes('2021'),
      `Expected "June 15, 2021" in referencedDate, got: ${result.referencedDate}`
    );
  });

  it('returns null observation for trivial exchange ("Thanks! / You\'re welcome!")', async () => {
    const content = `User: Thanks!
Assistant: You're welcome!`;
    const result = await observer.observe({ content });
    assert.equal(result.observation, null, 'observation should be null for trivial content');
  });

  it('observation is shorter than input (compression test)', async () => {
    const content = `User: I prefer to work remotely and my home office is set up in the spare bedroom.
Assistant: That sounds like a great setup! Having a dedicated workspace at home can really help with focus and productivity. Have you found any tips that help you stay productive?
User: Yes, I keep strict hours and I take regular breaks every hour or so to stretch and clear my head.
Assistant: That's a very disciplined approach! Regular breaks have been shown to improve overall productivity and mental well-being throughout the workday.`;

    const result = await observer.observe({ content });
    assert.ok(result.observation !== null, 'observation should not be null');
    assert.ok(
      result.observation.length < content.length,
      `Observation (${result.observation.length} chars) should be shorter than input (${content.length} chars)`
    );
    assert.ok(result.compressed === true, 'compressed flag should be true');
  });
});
