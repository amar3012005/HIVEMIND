---
when: designing or critiquing an interface, control, flow, or empty/error state where the user has to guess what is possible or what just happened
---

INTERACTION PRINCIPLES method (Don Norman, *The Design of Everyday Things*, revised edition):
Usability failures are gulfs, not user error. The Gulf of Execution is not knowing what to do; the Gulf of Evaluation is not knowing what happened. Five principles close them — affordances, signifiers, constraints, mapping, feedback — plus a sixth, the conceptual model.
1. LIST AFFORDANCES — enumerate every action the screen actually permits right now, including destructive and hidden ones.
2. MATCH SIGNIFIERS — for each affordance name the perceivable signifier that announces it (label, shape, cursor, shadow, motion, position). Every affordance without a signifier is a guess the user must make by trial and error; every signifier without an affordance is a lie. Fix both lists until they are one-to-one.
3. CONSTRAIN — add physical, logical, semantic, or cultural constraints that make the wrong action impossible rather than merely warned against.
4. MAP — check that control layout mirrors the spatial or temporal arrangement of what it controls. Arbitrary mappings must be memorized; state the natural mapping you used instead.
5. FEEDBACK — for every action name what confirms it within ~100ms, what the new state looks like, and how the user knows a slow action is still alive. Silence and spinners without state both fail.
6. CONCEPTUAL MODEL — write, in one sentence, the story the interface teaches about how the system works, then find where the interface contradicts that story.
Output the affordance-to-signifier table, the contradictions, and the fixes — not general advice.
