import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Every tracked file must be text. A single raw NUL byte is enough to make
// grep classify the file as binary and silently skip it, and
// file(1) report it as data, so searches for symbols defined there return
// importers but never the definition. That failure mode is invisible in a
// diff and in review (the byte renders as nothing), so it is asserted here
// instead. If a genuinely binary asset ever needs tracking, exclude it
// explicitly below rather than weakening the check.

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)

describe('tracked files are text', () => {
  it('no tracked file contains a NUL byte', () => {
    const binary = tracked.filter((path) => readFileSync(path).includes(0))
    expect(binary).toEqual([])
  })
})
