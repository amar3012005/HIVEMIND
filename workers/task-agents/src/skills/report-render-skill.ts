export const REPORT_RENDER_SKILL = `---
name: report-render
description: Load only while writing the final report. Sets the section order and forbids unsourced claims in the findings.
---

- Sections, in order: Decision, Company, What was done, Findings, Gaps, Sources.
- Every finding names the memory id or the page URL it came from.
- Put unsourced names in Gaps.
- Do not add a section the task did not ask for.
- For a requested PDF, finish the report as Markdown with a descriptive H1. The room runtime renders and attaches the PDF artifact from that report after your answer. Do not use browser_capture or HIVEMIND memory save as PDF substitutes.
`;
