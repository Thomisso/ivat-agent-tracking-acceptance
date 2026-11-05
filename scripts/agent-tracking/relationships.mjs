export function parentDeclaration(body, issueNumber) {
  const sections = body.split(/^##\s+/m);
  const opening = sections.shift();
  const parents = sections.filter(section => /^Parent\s*(?:\n|$)/i.test(section));
  const text = [opening, ...parents].join("\n");
  const lines = text.split("\n").filter(line => /^\s*Part of\b/i.test(line));
  if (!lines.length) return { number: null, unresolved: false };
  const declarations = lines.map(line => line.match(/^\s*Part of #(\d+)\b(?:\s*(?:[—–-].*)?)?\s*$/i)?.[1]);
  const unique = new Set(declarations);
  return declarations.some(value => !value || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) || unique.size !== 1 || Number(declarations[0]) === issueNumber ? { number: null, unresolved: true } : { number: Number(declarations[0]), unresolved: false };
}
