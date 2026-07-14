// Durable memories are reusable claims. Raw markup and code remain source
// evidence and should not compete with those claims in ordinary recall.
export function isStructuredSourceNoise(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < 4) return false;
  let braces = 0;
  let semicolons = 0;
  let colons = 0;
  let angles = 0;
  for (const char of text) {
    if (char === '{' || char === '}') braces++;
    else if (char === ';') semicolons++;
    else if (char === ':') colons++;
    else if (char === '<' || char === '>') angles++;
  }
  const styleOrCodeBlock = braces >= 2 && (semicolons > 0 || colons > 0);
  const markupFragment = angles >= 2 && text.startsWith('<') && text.includes('>');
  return styleOrCodeBlock || markupFragment;
}
