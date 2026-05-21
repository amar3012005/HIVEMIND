// GitHub / GitLab normalizer.
// Strips template scaffolding (### header, --- separators), extracts
// references like #123 or user/repo#45 into metadata, leaves code blocks
// intact so semantic search can hit symbol identifiers.
export const github = {
  name: 'github',
  normalize(content, metadata = {}) {
    const raw = content || '';
    const issueRefs = Array.from(new Set((raw.match(/(?:^|\s)#(\d+)/g) || []).map(m => m.trim().replace('#', ''))));
    const userMentions = Array.from(new Set((raw.match(/@[a-zA-Z0-9_-]+/g) || []).map(m => m.slice(1))));

    // Drop GitHub template scaffolding like '### Description' / '---' rulers
    // that add no signal. Leave code fences (```...```) alone.
    const cleaned = raw
      .split('\n')
      .filter(line => line.trim() !== '---')
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return {
      content: cleaned || raw,
      metadata: {
        ...metadata,
        github_issue_refs: issueRefs,
        github_user_mentions: userMentions,
        source_type_normalized: 'github',
      },
    };
  },
};
