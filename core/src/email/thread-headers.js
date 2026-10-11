/** Only real RFC Message-IDs can anchor an email thread; opaque provider receipt IDs cannot. */
export function validThreadMessageId(value) {
  return typeof value === 'string' && value.length <= 512 && /^<[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/.test(value) && !/[\s\r\n]/.test(value);
}
export function emailThreadHeaders(thread) {
  if (thread === undefined) return {};
  if (!thread || typeof thread !== 'object' || Array.isArray(thread) || Object.keys(thread).some(key => !['inReplyTo', 'references'].includes(key)) || !validThreadMessageId(thread.inReplyTo)) throw new Error('invalid_email_thread');
  const references = thread.references ?? thread.inReplyTo;
  if (typeof references !== 'string' || references.length > 2048 || !references.split(' ').every(validThreadMessageId)) throw new Error('invalid_email_thread');
  return {'In-Reply-To': thread.inReplyTo, References: references};
}
