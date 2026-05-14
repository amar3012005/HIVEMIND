/**
 * Contacts store — structured person index for email/connector ingestion.
 *
 * Replaces useless "Fact: X email is Y@z.com" memory pollution with a
 * proper contact graph queryable by email, name, or domain.
 *
 * Schema: hivemind.contacts (user_id, email, source_platform) unique key.
 */

function parseEmailHeader(headerValue) {
  if (!headerValue) return null;
  // Match "Display Name <email@x.com>" or bare "email@x.com"
  const angleMatch = headerValue.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (angleMatch) {
    const name = (angleMatch[1] || '').trim().replace(/\s+/g, ' ');
    const email = angleMatch[2].trim().toLowerCase();
    return { email, displayName: name || null };
  }
  const bareMatch = headerValue.match(/([\w.+-]+@[\w.-]+\.\w{2,})/);
  if (bareMatch) {
    return { email: bareMatch[1].toLowerCase(), displayName: null };
  }
  return null;
}

function splitAddresses(headerValue) {
  if (!headerValue) return [];
  // Split on commas not inside angle brackets/quotes
  const parts = [];
  let current = '';
  let depth = 0;
  let inQuote = false;
  for (const ch of headerValue) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === '<') depth++;
    else if (!inQuote && ch === '>') depth--;
    if (ch === ',' && depth === 0 && !inQuote) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export class ContactsStore {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Upsert a single contact. Increments msg_count + bumps last_seen_at on hit.
   */
  async upsert({ userId, orgId, email, displayName, sourcePlatform = 'gmail', eventDate = null }) {
    if (!email || !userId) return null;
    const normalizedEmail = String(email).toLowerCase().trim();
    if (!normalizedEmail || !normalizedEmail.includes('@')) return null;
    const domain = normalizedEmail.split('@')[1] || null;
    const seenAt = eventDate ? new Date(eventDate) : new Date();

    try {
      return await this.prisma.contact.upsert({
        where: {
          userId_email_sourcePlatform: {
            userId,
            email: normalizedEmail,
            sourcePlatform,
          },
        },
        update: {
          msgCount: { increment: 1 },
          lastSeenAt: seenAt,
          // Backfill displayName if it was previously null and we now have one
          ...(displayName ? { displayName } : {}),
        },
        create: {
          userId,
          orgId,
          email: normalizedEmail,
          displayName,
          sourcePlatform,
          domain,
          firstSeenAt: seenAt,
          lastSeenAt: seenAt,
          msgCount: 1,
        },
      });
    } catch (err) {
      // Non-fatal — contact upsert shouldn't block memory ingestion
      console.warn(`[contacts-store] upsert failed for ${normalizedEmail}: ${err.message}`);
      return null;
    }
  }

  /**
   * Bulk-upsert from a Gmail message — extracts From + To + Cc participants.
   */
  async upsertFromMessageHeaders({ userId, orgId, headers, sourcePlatform = 'gmail', eventDate = null }) {
    const fields = ['from', 'to', 'cc'];
    const results = [];
    for (const field of fields) {
      const value = headers[field] || headers[field.toLowerCase()] || '';
      const addresses = splitAddresses(value);
      for (const addr of addresses) {
        const parsed = parseEmailHeader(addr);
        if (parsed) {
          const result = await this.upsert({
            userId,
            orgId,
            email: parsed.email,
            displayName: parsed.displayName,
            sourcePlatform,
            eventDate,
          });
          if (result) results.push(result);
        }
      }
    }
    return results;
  }

  /**
   * Lookup: find contact by email (for queries like "who is X?")
   */
  async findByEmail(userId, email) {
    if (!email || !userId) return null;
    return this.prisma.contact.findFirst({
      where: {
        userId,
        email: String(email).toLowerCase(),
      },
    });
  }

  /**
   * List most-recent contacts (for dashboard "people you email with").
   */
  async listRecent(userId, { limit = 50, domain = null } = {}) {
    return this.prisma.contact.findMany({
      where: {
        userId,
        ...(domain ? { domain } : {}),
      },
      orderBy: { lastSeenAt: 'desc' },
      take: limit,
    });
  }
}

export { parseEmailHeader, splitAddresses };
