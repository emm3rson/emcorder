import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newRecordingFilename } from '../src/renderer/features/recordings/presentation'

test('recording filenames use padded local dates and 24-hour time without spaces or milliseconds', () => {
  assert.equal(newRecordingFilename(new Date(2026, 9, 23, 12, 48, 42, 513)), 'EmCorder_2026-10-23_12-48-42.mp4')
  assert.equal(newRecordingFilename(new Date(2026, 0, 2, 0, 3, 4)), 'EmCorder_2026-01-02_00-03-04.mp4')
  assert.equal(newRecordingFilename(new Date(2026, 11, 31, 23, 59, 59)), 'EmCorder_2026-12-31_23-59-59.mp4')
})
