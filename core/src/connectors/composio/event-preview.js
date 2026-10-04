/** Extract only known plain-text provider fields; never stringify a provider object as evidence. */
export function connectedEventPreview(data, max) {
  const preview = data?.preview;
  const candidates = [preview, data?.message_text, data?.text, data?.body,
    preview && typeof preview === 'object' && !Array.isArray(preview) ? preview.body : undefined];
  const value = candidates.find(item => typeof item === 'string' && item.trim());
  return (value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
