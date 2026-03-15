class IngestionAuditLogger {
  constructor(deps = {}) {
    this.records = [];
    this.externalLogger = deps.externalLogger || null;
  }

  async log(record) {
    const row = {
      ...record,
      logged_at: new Date().toISOString(),
    };

    this.records.push(row);

    if (this.externalLogger && typeof this.externalLogger.log === 'function') {
      await this.externalLogger.log({
        eventType: 'INGESTION_AUDIT',
        eventCategory: 'DATA_MODIFICATION',
        resourceType: 'INGESTION_JOB',
        resourceId: row.job_id,
        action: 'INGESTION_PIPELINE_COMPLETED',
        userId: row.user_id,
        metadata: row,
      });
    }

    return row;
  }

  getRecords() {
    return [...this.records];
  }
}

module.exports = {
  IngestionAuditLogger,
};
