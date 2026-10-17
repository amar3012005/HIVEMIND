import { readOwnedKnowledgeFile } from '../storage/knowledge-file-reference.js';

/** Existing HTTP authentication supplies principal; query parameters select only the native ID. */
export async function handleKnowledgeFileRoute({ req, res, url, principal, jsonResponse, ...stores }) {
  if (!stores.jobStore || !stores.prisma) return jsonResponse(res, { error: 'file_store_unavailable' }, 503);
  try {
    const { reference, bytes } = await readOwnedKnowledgeFile({ ...stores, principal, jobId: url.searchParams.get('job_id') });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Uploaded HTML/SVG is a download, never active content on the application origin.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(reference.name)}`);
    res.setHeader('Content-Length', String(bytes.length));
    res.statusCode = 200;
    res.end(bytes);
  } catch (error) {
    const allowed = new Set(['file_not_found', 'original_file_unavailable', 'file_requires_selected_remote_store',
      'file_storage_identity_mismatch', 'file_store_unavailable', 'file_integrity_failed', 'invalid_file_record']);
    const known = allowed.has(error?.code);
    return jsonResponse(res, { error: known ? error.code : 'file_store_unavailable' }, known ? error.status : 503);
  }
}
