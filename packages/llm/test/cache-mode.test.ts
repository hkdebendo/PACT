import { describe, expect, it } from 'vitest';
import { normaliseVolatile } from '../src/cache';

describe('replay key normalisation of the LLM mode', () => {
  it('treats live and replay verdicts as the same input, including inside JSON-in-JSON tool results', () => {
    const live = { output: JSON.stringify({ verdict: { llmMode: 'live', status: 'rejected' } }), row: { 'verdicts.llmMode': 'live' } };
    const replay = { output: JSON.stringify({ verdict: { llmMode: 'replay', status: 'rejected' } }), row: { 'verdicts.llmMode': 'replay' } };
    expect(normaliseVolatile(live).text).toBe(normaliseVolatile(replay).text);
    const other = { output: JSON.stringify({ verdict: { llmMode: 'live', status: 'approved' } }), row: { 'verdicts.llmMode': 'live' } };
    expect(normaliseVolatile(other).text).not.toBe(normaliseVolatile(live).text);
  });
});
