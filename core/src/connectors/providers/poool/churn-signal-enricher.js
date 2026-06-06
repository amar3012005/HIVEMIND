/**
 * Churn Signal Enricher for Real Estate
 *
 * Joins multiple data streams to create a churn probability signal:
 * 1. Late payments (SAP FI ∩ Poool)
 * 2. Support tickets (CRM ∩ Poool)
 * 3. Tone shift (sentiment analysis on tickets + comms)
 * 4. Silence (no contact x days)
 *
 * Output: churn_signal record emitted to HIVEMIND memory
 */

export class ChurnSignalEnricher {
  constructor(ctx) {
    this.prisma = ctx.prisma;
    this.logger = ctx.logger;
  }

  /**
   * Enrich a single lease with churn signals.
   *
   * @param {{ leaseId: string, propertyId: string, tenantId: string, orgId: string, userId: string }} context
   * @param {{ payments: Object[], tickets: Object[], communications: Object[] }} data
   * @returns {Promise<{ churnSignal: Object|null, riskScore: number, factors: string[] }>}
   */
  async enrichLease(context, data = {}) {
    const { leaseId, propertyId, tenantId, orgId, userId } = context;
    const { payments = [], tickets = [], communications = [] } = data;

    const factors = [];
    let riskScore = 0;

    // Factor 1: Late payments
    const latePayments = this._analyzeLatePayments(payments);
    if (latePayments.hasLate) {
      riskScore += latePayments.contribution;
      factors.push(
        `late_payment: ${latePayments.count} payment(s), max ${latePayments.maxDaysLate} days late`
      );
    }

    // Factor 2: Complaint tickets
    const complaints = this._analyzeTickets(tickets);
    if (complaints.hasComplaints) {
      riskScore += complaints.contribution;
      factors.push(
        `complaints: ${complaints.count} ticket(s), avg sentiment ${complaints.avgSentiment}`
      );
    }

    // Factor 3: Communication silence
    const silence = this._analyzeSilence(communications);
    if (silence.isSilent) {
      riskScore += silence.contribution;
      factors.push(`silence: no contact for ${silence.daysSilent} days`);
    }

    // Clamp risk score to 0-100
    riskScore = Math.min(100, Math.max(0, riskScore));

    // Only emit signal if risk exceeds threshold (e.g., 35%)
    const churnSignal = riskScore >= 35
      ? {
          id: `churn_signal:${leaseId}:${Date.now()}`,
          type: 'churn_signal',
          leaseId,
          propertyId,
          tenantId,
          orgId,
          userId,
          riskScore,
          factors,
          signals: {
            latePayments: latePayments.hasLate,
            complaints: complaints.hasComplaints,
            silence: silence.isSilent,
          },
          timestamp: new Date().toISOString(),
          recommendedAction: this._getRecommendedAction(riskScore, factors),
        }
      : null;

    return {
      churnSignal,
      riskScore,
      factors,
    };
  }

  /**
   * Analyze payment history for late payment patterns.
   * Returns contribution to risk score and details.
   */
  _analyzeLatePayments(payments) {
    let hasLate = false;
    let count = 0;
    let maxDaysLate = 0;

    for (const payment of payments) {
      if (payment.refs?.isLate) {
        hasLate = true;
        count += 1;

        if (payment.refs.dueDate && payment.refs.paidDate) {
          const due = new Date(payment.refs.dueDate);
          const paid = new Date(payment.refs.paidDate);
          const daysLate = Math.ceil((paid - due) / (1000 * 60 * 60 * 24));
          maxDaysLate = Math.max(maxDaysLate, daysLate);
        }
      }
    }

    return {
      hasLate,
      count,
      maxDaysLate,
      contribution: hasLate ? (20 + Math.min(30, maxDaysLate / 3)) : 0, // 20-50 points
    };
  }

  /**
   * Analyze ticket sentiment and categorization for complaints.
   */
  _analyzeTickets(tickets) {
    let hasComplaints = false;
    let count = 0;
    let sentimentSum = 0;

    for (const ticket of tickets) {
      const sentiment = ticket.refs?.sentiment || 'neutral';
      if (sentiment === 'negative') {
        hasComplaints = true;
        count += 1;
        sentimentSum -= 1;
      } else if (sentiment === 'neutral') {
        sentimentSum += 0;
      } else if (sentiment === 'positive') {
        sentimentSum += 1;
      }
    }

    const avgSentiment = count > 0 ? (sentimentSum / count).toFixed(2) : 0;

    return {
      hasComplaints,
      count,
      avgSentiment,
      contribution: hasComplaints ? (15 + Math.min(25, count * 5)) : 0, // 15-40 points
    };
  }

  /**
   * Analyze communication pattern for silence (no contact x days).
   */
  _analyzeSilence(communications = []) {
    if (!communications.length) {
      // No communication data: assume complete silence
      return {
        isSilent: true,
        daysSilent: 999, // Use large number to indicate unknown
        contribution: 15,
      };
    }

    // Find most recent communication
    const sorted = communications
      .map((c) => ({
        date: new Date(c.ts || c.timestamp || Date.now()),
        ...c,
      }))
      .sort((a, b) => b.date - a.date);

    const lastContact = sorted[0]?.date;
    const now = new Date();
    const daysSilent = Math.floor((now - lastContact) / (1000 * 60 * 60 * 24));

    const isSilent = daysSilent >= 30; // 30+ days = silence
    const contribution = isSilent ? 10 + Math.min(20, daysSilent / 5) : 0; // 10-30 points

    return {
      isSilent,
      daysSilent,
      contribution,
    };
  }

  /**
   * Recommend action based on risk level.
   */
  _getRecommendedAction(riskScore, factors) {
    if (riskScore >= 75) {
      return 'URGENT: Immediate contact required. Risk of lease termination.';
    }
    if (riskScore >= 50) {
      return 'HIGH: Schedule follow-up call or visit within 7 days.';
    }
    if (riskScore >= 35) {
      return 'MEDIUM: Monitor closely. Send courtesy reminder email.';
    }
    return null;
  }

  /**
   * Batch enrich multiple leases.
   * Returns list of churn signals for memory ingestion.
   */
  async enrichBatch(context, leaseDataMap) {
    const results = [];

    for (const [leaseId, leaseData] of Object.entries(leaseDataMap)) {
      const result = await this.enrichLease(
        { ...context, leaseId },
        leaseData
      );

      if (result.churnSignal) {
        results.push(result.churnSignal);
      }
    }

    return results;
  }
}
