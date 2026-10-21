// Tests for the claude.ai completion-stream parser. The TS source is bundled on the fly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as esbuild from 'esbuild';

const out = await esbuild.build({
  entryPoints: ['packages/extension/src/claude/completion.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  define: { __VERSION__: '"test"' },
});
const api = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

/** A Response whose body arrives in the given pieces (to exercise split events). */
function streamed(pieces) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of pieces) c.enqueue(enc.encode(p));
        c.close();
      },
    })
  );
}

const ev = (type, data) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...data })}\r\n\r\n`;

test('parses the messages format, skipping thinking and tool blocks', async () => {
  const body =
    ev('message_start', { message: { uuid: 'msg-1' } }) +
    ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }) +
    ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Hello' } }) +
    ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: ', world' } }) +
    ev('content_block_start', { index: 2, content_block: { type: 'tool_use' } }) +
    ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } }) +
    ev('message_delta', { delta: { stop_reason: 'end_turn' } }) +
    ev('message_stop', {});
  // Split at awkward places, including between \r and \n.
  const pieces = [body.slice(0, 7), body.slice(7, 130), body.slice(130, 131), body.slice(131)];
  const chunks = [];
  const r = await api.readCompletionStream(streamed(pieces), (t) => chunks.push(t));
  assert.equal(r.text, 'Hello, world');
  assert.deepEqual(chunks, ['Hello', ', world']);
  assert.equal(r.messageId, 'msg-1');
  assert.equal(r.stopReason, 'end_turn');
});

test('parses the older completion format', async () => {
  const body =
    `data: ${JSON.stringify({ type: 'completion', completion: 'Hi ', stop_reason: null, id: 'c1' })}\n\n` +
    `data: ${JSON.stringify({ type: 'completion', completion: 'there', stop_reason: 'stop_sequence' })}\n\n`;
  const r = await api.readCompletionStream(streamed([body]), () => {});
  assert.equal(r.text, 'Hi there');
  assert.equal(r.stopReason, 'stop_sequence');
  assert.equal(r.messageId, 'c1');
});

test('maps a usage-limit stream error to RATE_LIMITED with a reset time', async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const body = ev('error', { error: { type: 'rate_limit_error', message: JSON.stringify({ type: 'exceeded_limit', resetsAt }) } });
  await assert.rejects(api.readCompletionStream(streamed([body]), () => {}), (e) => {
    assert.equal(e.code, 'RATE_LIMITED');
    assert.ok(e.retryAfter > 3500 && e.retryAfter <= 3600, `retryAfter ${e.retryAfter}`);
    return true;
  });
});

test('an empty stream is an error, not an empty reply', async () => {
  await assert.rejects(api.readCompletionStream(streamed([ev('message_stop', {})]), () => {}), (e) => e.code === 'UPSTREAM_ERROR');
});
