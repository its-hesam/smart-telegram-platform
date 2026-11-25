import { expect, it } from 'vitest';
import { renderMessage } from '../../packages/shared/src/template.js';
it('renders only approved name variables and rejects arbitrary field access', () => {
  expect(renderMessage('سلام {{ name }} 👋', 'تست')).toBe('سلام تست 👋');
  expect(() => renderMessage('{{contact.phone}}', 'Test')).toThrow();
  expect(() => renderMessage('{{constructor}}', 'Test')).toThrow();
});
