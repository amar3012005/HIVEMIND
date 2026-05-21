// Gmail / email normalizer.
// Strips RFC-822 headers, signature blocks, quoted replies, tracking
// pixels, and extracts structured fields (Subject, From, Date) into
// metadata so the bucket router can promote them onto the parent.
export const gmail = {
  name: 'gmail',
  normalize(content, metadata = {}) {
    const raw = content || '';
    const subject = extractField(raw, 'Subject') || metadata.email_subject || metadata.subject || '';
    const from = extractField(raw, 'From') || metadata.email_from || '';
    const date = extractField(raw, 'Date') || metadata.email_date || '';
    const body = stripHeaders(raw);

    // Strip Gmail-style quoted reply blocks (`On … wrote:` and `>` prefix lines)
    const cleanBody = body
      .split('\n')
      .filter(line => !/^On\s+.+\s+wrote:$/i.test(line.trim()))
      .filter(line => !/^>\s/.test(line))
      .filter(line => !/^--\s*$/.test(line.trim()))   // signature delimiter
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')                    // collapse excess blanks
      .trim();

    // Rebuild headed form so the LLM sees structured context
    const cleanContent = [
      subject ? `Subject: ${subject}` : '',
      from    ? `From: ${from}`       : '',
      date    ? `Date: ${date}`       : '',
      cleanBody,
    ].filter(Boolean).join('\n');

    return {
      content: cleanContent || raw,
      metadata: {
        ...metadata,
        email_subject: subject || null,
        email_from: from || null,
        email_date: date || null,
        source_type_normalized: 'gmail',
      },
    };
  },
};

function extractField(content, field) {
  const re = new RegExp(`^${field}:\\s*(.+)$`, 'mi');
  const m = (content || '').match(re);
  return m ? m[1].trim() : null;
}

function stripHeaders(content) {
  const lines = (content || '').split('\n');
  const headerKeys = ['Subject', 'From', 'To', 'Cc', 'Bcc', 'Date', 'Reply-To', 'Message-ID', 'Mime-Version', 'Content-Type'];
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { bodyStart = i + 1; break; }
    const isHeader = headerKeys.some(k => line.startsWith(`${k}:`));
    if (!isHeader && i > 0) { bodyStart = i; break; }
  }
  return lines.slice(bodyStart).join('\n');
}
