import test from 'node:test'
import assert from 'node:assert/strict'
import { AdvisorySession, blurAdvisory } from '../src/renderer/features/notices/advisories'

test('routine blur states never become advisories', () => {
  for (const status of ['Connect your camera to begin.', 'Loading camera blur…', 'Camera blur is preparing…', 'Camera blur is ready.', 'Camera blur is off.']) {
    assert.equal(blurAdvisory(status), null)
  }
})

test('transient blur slowdown is ignored and sustained slowdown appears only once', () => {
  const session = new AdvisorySession()
  const slow = blurAdvisory('Camera blur is running slowly; reduce other camera effects for smoother video.')!
  assert.deepEqual(session.observe([slow], 0), [])
  assert.equal(session.waiting, true)
  assert.deepEqual(session.observe([], 1900), [])
  assert.equal(session.waiting, false)
  assert.deepEqual(session.observe([slow], 2000), [])
  assert.deepEqual(session.observe([slow], 3999), [])
  assert.deepEqual(session.observe([slow], 4000), [slow])
  assert.equal(session.waiting, false)
  session.observe([], 5000)
  assert.deepEqual(session.observe([slow], 6000), [])
  assert.deepEqual(session.observe([slow], 9000), [])
  const nextTake = new AdvisorySession()
  nextTake.observe([slow], 9000)
  assert.deepEqual(nextTake.observe([slow], 11000), [slow])
})

test('delayed and failed blur share one issue while microphone advisories remain independent', () => {
  const session = new AdvisorySession()
  const delayed = blurAdvisory('Camera blur is delayed. Showing the camera without blur until a fresh mask arrives.')!
  const unavailable = blurAdvisory('Camera blur unavailable: synthetic failure. Showing the camera without blur.')!
  const quiet = { id: 'microphone-quiet', message: 'Quiet', delayMs: 0 }
  assert.deepEqual(session.observe([delayed], 0), [])
  assert.deepEqual(session.observe([unavailable, quiet], 2000), [unavailable, quiet])
  assert.deepEqual(session.observe([delayed, quiet], 5000), [])
})
