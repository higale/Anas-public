import { describe, expect, it, vi } from 'vitest'
import type koffi from 'koffi'
import * as fs from 'node:fs'
import { createPosixPtySession } from './posixPtySession'

function fixture() {
  const records = new Map([[64, { session: 64, status: 2, birth: 100 }], [65, { session: 64, status: 2, birth: 101 }], [66, { session: 66, status: 2, birth: 102 }]])
  const enumerate = vi.fn((buffer: Int32Array) => { buffer.set([...records.keys()]); return records.size })
  const info = vi.fn((pid: number, _flavor: number, _arg: number, buffer: Buffer) => { buffer.writeUInt32LE(pid); return records.has(pid) ? buffer.length : 0 })
  const native = {
    load: () => ({ func: (signature: string) => signature.includes('getsid') ? (pid: number) => records.get(pid)?.session ?? -1 : signature.includes('proc_listallpids') ? enumerate : info }),
    struct: () => ({}), array: () => ({}), sizeof: () => 136,
    decode: (buffer: Buffer) => {
      const pid = buffer.readUInt32LE()
      const record = records.get(pid)!
      return { pid, status: record.status, startedSeconds: record.birth, startedMicros: 0 }
    }
  } as unknown as typeof koffi
  const session = createPosixPtySession(native, fs, 'darwin')
  const leader = session.inspect(64)!
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal === 'SIGSTOP') records.get(pid)!.status = 4
    if (signal === 'SIGKILL') records.delete(pid)
    return true
  })
  return { records, enumerate, info, session, leader, kill }
}

describe('POSIX PTY session target verification', () => {
  it('freezes and kills only verified members, leaving the guardian and other sessions untouched', () => {
    const { session, leader, kill, records } = fixture()
    expect(session.terminate(leader, true)).toBe(true)
    expect(kill.mock.calls).toEqual([[65, 'SIGSTOP'], [65, 'SIGKILL']])
    expect([...records.keys()]).toEqual([64, 66])
  })
  it('rejects a replaced session leader before enumerating or signalling processes', () => {
    const { session, leader, kill, records, enumerate } = fixture()
    records.get(64)!.birth += 1
    expect(session.terminate(leader, true)).toBe(false)
    expect(enumerate).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })
  it('does not report incomplete process enumeration as confirmed containment', () => {
    const { session, leader, kill, enumerate } = fixture()
    enumerate.mockReturnValue(65_536)
    expect(session.terminate(leader, true)).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })
  it('does not mistake an unreadable known session member for an exited process', () => {
    const { session, leader, info, kill } = fixture()
    info.mockImplementation((pid, _flavor, _arg, buffer) => { buffer.writeUInt32LE(pid); return pid === 65 ? 0 : buffer.length })
    expect(session.terminate(leader, true)).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })
})
