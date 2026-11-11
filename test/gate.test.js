import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const TEMPLATE = fileURLToPath(new URL('../strategy-template.md', import.meta.url))

function makeGate(config = {}) {
  let handler
  const ctx = {
    effect(fn) {
      fn()
    },
    on(event, fn) {
      if (event === 'tools/pre-execute') handler = fn
    },
  }
  apply(ctx, config)
  return {
    async call(exec) {
      return handler(exec, () => ({ allowed: true }))
    },
  }
}

const readGif = (id, file = 'C:\\tmp\\clip.gif', tool = 'read_image') => ({
  name: tool,
  arguments: { file_path: file },
  agent: { id },
})

test('first animated read is denied and carries the strategy path', async () => {
  const gate = makeGate()
  const result = await gate.call(readGif('a'))
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /gif-gate/)
  assert.match(result.reason, /strategy-template\.md/)
})

test('reading the strategy document releases the session', async () => {
  const gate = makeGate()
  assert.equal((await gate.call(readGif('b'))).kind, 'deny')
  const ack = await gate.call({
    name: 'read',
    arguments: { file_path: TEMPLATE },
    agent: { id: 'b' },
  })
  assert.deepEqual(ack, { allowed: true })
  assert.deepEqual(await gate.call(readGif('b')), { allowed: true })
})

test('non-animated paths pass', async () => {
  const gate = makeGate()
  assert.deepEqual(await gate.call(readGif('c', 'C:\\tmp\\still.png')), { allowed: true })
})

test('webp is guarded as well', async () => {
  const gate = makeGate()
  assert.equal((await gate.call(readGif('d', 'C:\\tmp\\anim.webp'))).kind, 'deny')
})

test('at most two denials, then it fails open', async () => {
  const gate = makeGate()
  assert.equal((await gate.call(readGif('e'))).kind, 'deny')
  assert.equal((await gate.call(readGif('e'))).kind, 'deny')
  assert.deepEqual(await gate.call(readGif('e')), { allowed: true })
})

test('denials are per session', async () => {
  const gate = makeGate()
  assert.equal((await gate.call(readGif('f1'))).kind, 'deny')
  assert.equal((await gate.call(readGif('f2'))).kind, 'deny')
})

test('a missing strategy document fails open', async () => {
  const gate = makeGate({ strategyPath: 'C:\\no-such-dir\\strategy.md' })
  assert.deepEqual(await gate.call(readGif('g')), { allowed: true })
})

test('only guarded tools are intercepted', async () => {
  const gate = makeGate()
  assert.deepEqual(
    await gate.call({ name: 'bash', arguments: { command: 'ls clip.gif' }, agent: { id: 'h' } }),
    { allowed: true },
  )
})

test('reading an unrelated file does not release the session', async () => {
  const gate = makeGate()
  await gate.call({ name: 'read', arguments: { file_path: 'C:\\tmp\\notes.md' }, agent: { id: 'i' } })
  assert.equal((await gate.call(readGif('i'))).kind, 'deny')
})
