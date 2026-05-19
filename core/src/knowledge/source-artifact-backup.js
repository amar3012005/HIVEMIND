/**
 * SourceArtifactBackup — sends new source_artifact.payload to S3-compat blob
 * storage (R2 / S3 / B2) using simple PUT. Async fire-and-forget.
 *
 * Triggered post-write inside ingestKnowledgeDocument /
 * ingestEnterpriseDocument / ingestConnectorRecord when env is configured.
 */

import crypto from 'node:crypto';

export class SourceArtifactBackup {
  constructor({ logger = console, prisma = null } = {}) {
    this.logger = logger;
    this.prisma = prisma;
    this.bucket = process.env.SOURCE_ARTIFACT_BUCKET || null;
    this.endpoint = process.env.SOURCE_ARTIFACT_ENDPOINT || null;
    this.accessKey = process.env.SOURCE_ARTIFACT_ACCESS_KEY || null;
    this.secretKey = process.env.SOURCE_ARTIFACT_SECRET_KEY || null;
    this.region = process.env.SOURCE_ARTIFACT_REGION || 'auto';
    this.enabled = !!(this.bucket && this.endpoint && this.accessKey && this.secretKey);
    if (this.enabled) this.logger.info?.(`[source-backup] enabled bucket=${this.bucket}`);
  }

  /** AWS SigV4 PUT — used for S3 / R2 / B2 compatible endpoints. */
  async backup({ artifactId, checksum, contentType, payload }) {
    if (!this.enabled) return false;
    try {
      const key = `${artifactId}/${checksum}`;
      const url = `${this.endpoint.replace(/\/$/, '')}/${this.bucket}/${key}`;
      const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload || {}), 'utf8');
      const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
      const dateShort = date.slice(0, 8);
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');

      // Minimal SigV4 — assumes path-style endpoint
      const host = new URL(url).host;
      const canonicalReq = [
        'PUT',
        new URL(url).pathname,
        '',
        `content-type:${contentType || 'application/octet-stream'}`,
        `host:${host}`,
        `x-amz-content-sha256:${sha256}`,
        `x-amz-date:${date}`,
        '',
        'content-type;host;x-amz-content-sha256;x-amz-date',
        sha256,
      ].join('\n');

      const stringToSign = [
        'AWS4-HMAC-SHA256',
        date,
        `${dateShort}/${this.region}/s3/aws4_request`,
        crypto.createHash('sha256').update(canonicalReq).digest('hex'),
      ].join('\n');

      const kDate = crypto.createHmac('sha256', 'AWS4' + this.secretKey).update(dateShort).digest();
      const kRegion = crypto.createHmac('sha256', kDate).update(this.region).digest();
      const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
      const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
      const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

      const auth = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${dateShort}/${this.region}/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=${signature}`;

      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType || 'application/octet-stream',
          'Host': host,
          'x-amz-content-sha256': sha256,
          'x-amz-date': date,
          'Authorization': auth,
        },
        body,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.warn?.(`[source-backup] PUT ${res.status}: ${text.slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn?.(`[source-backup] failed: ${err.message}`);
      return false;
    }
  }
}
