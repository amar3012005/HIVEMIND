// Google Drive / Docs / Sheets / Slides normalizer.
// Docs come in as markdown via the workspace-mcp sidecar; this strips
// the boilerplate header injected by the adapter ("Document ID: ...")
// and promotes drive metadata onto the parent.
export const drive = {
  name: 'drive',
  normalize(content, metadata = {}) {
    let body = content || '';

    // Drop "Document ID: ..." and "Last Modified: ..." headers that the
    // workspace-mcp adapter prepends — they're already in metadata.
    body = body
      .split('\n')
      .filter(line => !/^(Document ID|Last Modified|Owner|Created|Modified):\s/i.test(line.trim()))
      .join('\n')
      .replace(/^\n+/, '')
      .trim();

    return {
      content: body || content || '',
      metadata: {
        ...metadata,
        drive_file_id: metadata.file_id || metadata.fileId || metadata.drive_file_id || null,
        drive_mime: metadata.mime_type || metadata.mimeType || null,
        source_type_normalized: 'drive',
      },
    };
  },
};
