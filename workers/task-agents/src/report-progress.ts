export interface ReportProgress<Row, Learning> {
  needsInput: boolean;
  question: string;
  options: string[];
  report: string;
  completedTaskIds: number[];
  operatingLearnings: Learning[];
  prospects: Row[];
}

/** A continuation adds evidence; a partial model response cannot erase earlier receipts. */
export function mergeReportProgress<Row extends { locationUrl: string }, Learning extends { title: string }>(
  previous: ReportProgress<Row, Learning>, next: ReportProgress<Row, Learning>,
): ReportProgress<Row, Learning> {
  const latest = next.report.trim();
  const earlier = previous.report.trim();
  const report = !latest ? earlier : !earlier || latest.length >= earlier.length * 0.75
    ? latest : earlier.includes(latest) ? earlier : `${earlier}\n\n${latest}`;
  const rows = new Map(previous.prospects.map((row) => [row.locationUrl, row]));
  for (const row of next.prospects) rows.set(row.locationUrl, { ...rows.get(row.locationUrl), ...row });
  const learnings = new Map(previous.operatingLearnings.map((item) => [item.title, item]));
  for (const item of next.operatingLearnings) learnings.set(item.title, item);
  return {
    needsInput: next.needsInput,
    question: next.question,
    options: next.options,
    report,
    completedTaskIds: [...new Set([...previous.completedTaskIds, ...next.completedTaskIds])].slice(0, 6),
    operatingLearnings: [...learnings.values()].slice(0, 2),
    prospects: [...rows.values()].slice(0, 30),
  };
}
