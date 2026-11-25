export function renderMessage(template: string, name: string) {
  const variables = [...template.matchAll(/\{\{\s*([^{}]+)\s*\}\}/g)].map(m => m[1]!.trim());
  if (variables.some(v => v !== 'name')) throw new Error('UNSUPPORTED_TEMPLATE_VARIABLE');
  return template.replace(/\{\{\s*name\s*\}\}/g, name);
}
