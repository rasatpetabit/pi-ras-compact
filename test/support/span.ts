import type { Message } from '../../src/vendor/pi-jev/vendor/fast-jev-compaction/index.js';

export const user = (text: string): Message => ({ role: 'user', text, toolUses: [], toolResults: [] });
export const context = (text: string): Message => ({ role: 'user', text, toolUses: [], toolResults: [], source: 'custom' });
export const say = (text: string): Message => ({ role: 'assistant', text, toolUses: [] });
export function call(id: string, tool: string, input: Record<string, unknown>, result: string, isError = false): Message[] {
  return [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: result, isError }] },
  ];
}
export const big = (label: string, lines: number): string =>
  Array.from({ length: lines }, (_, i) => `${label} line ${i}: const v${i} = compute(${i});`).join('\n');
