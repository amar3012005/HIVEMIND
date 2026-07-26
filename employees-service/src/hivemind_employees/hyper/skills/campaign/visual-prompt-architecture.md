---
when: Use only when a campaign action materially benefits from an original image; skip it for text-only actions.
---
# Visual Prompt Architecture

Apply this method only after deciding that an image improves comprehension, attention, proof, or emotional clarity. Never add an image merely to decorate every action.

For each visual action, turn the grounded campaign strategy into one production-ready art-direction contract:

1. State the communication objective the image must achieve without repeating the Post copy.
2. Name a concrete, inspectable subject. Prefer the real product, workflow, people, place, or outcome over abstract technology imagery.
3. Specify composition, viewpoint, focal hierarchy, lighting, environment, materials, and responsive-crop safe area.
4. Translate verified company brand information into a visual language. Do not invent brand colors, logos, product screens, customers, awards, metrics, or UI.
5. Identify the audience and the emotional interpretation the creative should produce.
6. List required elements and forbidden elements separately. Put unsupported claims in the forbidden list.
7. Default to no generated text. Exact typography and logos belong in deterministic composition or an uploaded replacement.
8. Write concise alt text describing the finished visual, not the prompt.
9. Finish with one detailed generation prompt that is self-contained and does not refer to earlier discussion.

The image gate is strict: `creative_brief.required` is true only when the action benefits materially from a visual. When false, explain the choice briefly and leave generation fields empty.
