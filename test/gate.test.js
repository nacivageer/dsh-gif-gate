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

test('guardStatic off: png still passes (默认行为不变)', async () => {
  const gate = makeGate()
  assert.deepEqual(await gate.call(readGif('j', 'C:\\tmp\\still.png')), { allowed: true })
})

test('guardStatic on: png is denied until strategy read', async () => {
  const gate = makeGate({ guardStatic: true })
  const first = await gate.call(readGif('k', 'C:\\tmp\\still.png'))
  assert.equal(first.kind, 'deny')
  assert.match(first.reason, /拦下读图/)
  const ack = await gate.call({
    name: 'read',
    arguments: { file_path: TEMPLATE },
    agent: { id: 'k' },
  })
  assert.deepEqual(ack, { allowed: true })
  assert.deepEqual(await gate.call(readGif('k', 'C:\\tmp\\still.png')), { allowed: true })
})

test('guardStatic on: jpg and gif both guarded', async () => {
  const jpgGate = makeGate({ guardStatic: true })
  assert.equal((await jpgGate.call(readGif('l', 'C:\\tmp\\photo.jpg'))).kind, 'deny')
  const gifGate = makeGate({ guardStatic: true })
  assert.equal((await gifGate.call(readGif('m', 'C:\\tmp\\clip.gif'))).kind, 'deny')
})

test('guardStatic on: 不看扩展名——无后缀、heic、大写 PNG 都拦', async () => {
  const noExt = makeGate({ guardStatic: true })
  assert.equal((await noExt.call(readGif('n', 'C:\\tmp\\screenshot'))).kind, 'deny')
  const heic = makeGate({ guardStatic: true })
  assert.equal((await heic.call(readGif('o', 'C:\\tmp\\photo.heic'))).kind, 'deny')
  const upper = makeGate({ guardStatic: true })
  assert.equal((await upper.call(readGif('p', 'C:\\tmp\\IMG_0001.PNG'))).kind, 'deny')
})
