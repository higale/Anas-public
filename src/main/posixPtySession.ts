import type koffi from 'koffi'
import type * as fs from 'node:fs'

/** Kept self-contained so the exact same implementation runs in the existing
 * guardian and its owner. Job-control groups share a POSIX session, not a PGID.
 * Koffi is already shipped; use kernel identities, not parsed ps descriptions. */
export function createPosixPtySession(native: typeof koffi, filesystem: Pick<typeof fs, 'readFileSync' | 'readdirSync'>, platform = process.platform) {
  if (platform !== 'darwin' && platform !== 'linux') throw new Error('PTY session control is unsupported on this platform.')
  const library = native.load(null)
  const getsid = library.func('int getsid(int pid)')
  const listPids = platform === 'darwin' ? library.func('int proc_listallpids(void *buffer, int buffersize)') : undefined
  const pidInfo = platform === 'darwin' ? library.func('int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)') : undefined
  // Public macOS proc_bsdinfo (PROC_PIDTBSDINFO=3), identical on x64/arm64.
  const bsdInfo = pidInfo ? native.struct({
    flags: 'uint32', status: 'uint32', xstatus: 'uint32', pid: 'uint32', ppid: 'uint32',
    uid: 'uint32', gid: 'uint32', ruid: 'uint32', rgid: 'uint32', svuid: 'uint32', svgid: 'uint32', reserved: 'uint32',
    comm: native.array('char', 16), name: native.array('char', 32),
    nfiles: 'uint32', pgid: 'uint32', jobc: 'uint32', tdev: 'uint32', tpgid: 'uint32', nice: 'int32',
    startedSeconds: 'uint64', startedMicros: 'uint64'
  }) : undefined
  const pause = new Int32Array(new SharedArrayBuffer(4))
  type Identity = { pid: number; session: number; birth: string; stopped: boolean; zombie: boolean }

  function inspect(pid: number): Identity | undefined {
    if (!Number.isSafeInteger(pid) || pid <= 1) return undefined
    const session = Number(getsid(pid))
    if (session <= 0) return undefined
    if (pidInfo && bsdInfo) {
      const data = Buffer.alloc(native.sizeof(bsdInfo))
      if (pidInfo(pid, 3, 0, data, data.length) !== data.length) return undefined
      const info = native.decode(data, bsdInfo) as { pid: number; status: number; startedSeconds: number | bigint; startedMicros: number | bigint }
      if (info.pid !== pid) return undefined
      return { pid, session, birth: `${info.startedSeconds}:${info.startedMicros}`, stopped: info.status === 4, zombie: info.status === 5 }
    }
    try {
      // Linux /proc stat: comm may itself contain spaces and parentheses.
      const text = filesystem.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
      if (fields.length < 20 || Number(fields[3]) !== session || !/^\d+$/.test(fields[19])) return undefined
      return { pid, session, birth: fields[19], stopped: fields[0] === 'T' || fields[0] === 't', zombie: fields[0] === 'Z' }
    } catch { return undefined }
  }

  function members(session: number): Identity[] {
    let pids: number[]
    if (listPids) {
      // A fixed bounded kernel buffer detects truncation instead of pretending
      // that an incomplete host enumeration proves the session is empty.
      const data = new Int32Array(65_536)
      const count = Number(listPids(data, data.byteLength))
      if (count <= 0 || count >= data.length) throw new Error('PTY process enumeration is unavailable or exceeds its budget.')
      pids = Array.from(data.subarray(0, count))
    } else {
      const entries = filesystem.readdirSync('/proc')
      if (entries.length > 65_536) throw new Error('PTY process enumeration exceeds its budget.')
      pids = entries.filter((name) => /^\d+$/.test(name)).map(Number)
    }
    return pids.flatMap((pid) => {
      if (pid <= 1 || pid === session || getsid(pid) !== session) return []
      const info = inspect(pid)
      if (!info || info.session !== session) {
        if (getsid(pid) === session) throw new Error('Could not verify a PTY session member.')
        return []
      }
      return info.zombie ? [] : [info]
    })
  }

  function signalMember(info: Identity, signal: NodeJS.Signals): boolean {
    const current = inspect(info.pid)
    if (!current) {
      try { process.kill(info.pid, 0); return false } catch (error) {
        return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
      }
    }
    if (current.birth !== info.birth || current.session !== info.session || current.zombie) return true
    try { process.kill(info.pid, signal); return true } catch (error) {
      return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
    }
  }

  function terminate(leader: Identity, force: boolean): boolean {
    if (leader.pid <= 1 || leader.session !== leader.pid) return false
    const current = inspect(leader.pid)
    // Never use a reused leader PID to identify a new, unrelated session.
    if (current && (current.birth !== leader.birth || current.session !== leader.session)) return false
    if (!current && getsid(leader.pid) > 0) return false
    const observed = new Map<number, Identity>()
    let confirmed = true
    try {
      if (!force) {
        for (const info of members(leader.session)) confirmed = signalMember(info, 'SIGTERM') && confirmed
        return confirmed
      }
      // Freeze job-control members before taking the next membership snapshot;
      // otherwise a normal build can fork between enumeration and termination.
      const deadline = performance.now() + 400
      for (;;) {
        const live = members(leader.session)
        for (const info of live) {
          observed.set(info.pid, info)
          if (!info.stopped) confirmed = signalMember(info, 'SIGSTOP') && confirmed
        }
        if (live.every((info) => info.stopped)) break
        if (performance.now() >= deadline) { confirmed = false; break }
        Atomics.wait(pause, 0, 0, 10)
      }
    } catch { confirmed = false }
    // Always reclaim the exact members already captured, including on a failed
    // enumeration. Do not leave stopped jobs behind or signal a replacement PID.
    for (const info of observed.values()) confirmed = signalMember(info, 'SIGKILL') && confirmed
    return confirmed
  }

  return { inspect, terminate, signalMember }
}
