import { createRequire } from 'node:module'

const jobObjectExtendedLimitInformation = 9
const jobObjectLimitKillOnJobClose = 0x0000_2000
const processSetQuota = 0x0100
const processTerminate = 0x0001

interface WindowsJobBindings {
  assignProcessToJobObject(job: unknown, process: unknown): number
  closeHandle(handle: unknown): number
  createJobObjectW(attributes: null, name: null): unknown
  getLastError(): number
  openProcess(access: number, inheritHandle: number, processId: number): unknown
  setInformationJobObject(job: unknown, infoClass: number, info: Buffer, length: number): number
  terminateJobObject(job: unknown, exitCode: number): number
  extendedLimitInformationSize: number
  limitFlagsOffset: number
}

let cachedBindings: WindowsJobBindings | undefined
const requireWindowsDependency = createRequire(import.meta.url)

function bindings(): WindowsJobBindings {
  if (process.platform !== 'win32') {
    throw new Error('Windows Job Objects are only available on Windows.')
  }
  if (cachedBindings) return cachedBindings
  // Loading the native FFI binding is Windows-only. shellRuntime is also used
  // on macOS and Linux, where eager loading would add an unnecessary native
  // startup dependency.
  const koffi = requireWindowsDependency('koffi') as typeof import('koffi').default
  const handleType = koffi.pointer('void')
  const basicLimitInformationType = koffi.struct({
    perProcessUserTimeLimit: 'int64',
    perJobUserTimeLimit: 'int64',
    limitFlags: 'uint32',
    minimumWorkingSetSize: 'uintptr_t',
    maximumWorkingSetSize: 'uintptr_t',
    activeProcessLimit: 'uint32',
    affinity: 'uintptr_t',
    priorityClass: 'uint32',
    schedulingClass: 'uint32'
  })
  const ioCountersType = koffi.struct({
    readOperationCount: 'uint64',
    writeOperationCount: 'uint64',
    otherOperationCount: 'uint64',
    readTransferCount: 'uint64',
    writeTransferCount: 'uint64',
    otherTransferCount: 'uint64'
  })
  const extendedLimitInformationType = koffi.struct({
    basicLimitInformation: basicLimitInformationType,
    ioInfo: ioCountersType,
    processMemoryLimit: 'uintptr_t',
    jobMemoryLimit: 'uintptr_t',
    peakProcessMemoryUsed: 'uintptr_t',
    peakJobMemoryUsed: 'uintptr_t'
  })
  const kernel32 = koffi.load('kernel32.dll')
  const bind = (name: string, result: string | typeof handleType, args: Array<string | typeof handleType>) => (
    kernel32.func('__stdcall', name, result, args)
  )
  cachedBindings = {
    assignProcessToJobObject: bind('AssignProcessToJobObject', 'int', [handleType, handleType]),
    closeHandle: bind('CloseHandle', 'int', [handleType]),
    createJobObjectW: bind('CreateJobObjectW', handleType, [handleType, 'str16']),
    getLastError: bind('GetLastError', 'uint32', []),
    openProcess: bind('OpenProcess', handleType, ['uint32', 'int', 'uint32']),
    setInformationJobObject: bind('SetInformationJobObject', 'int', [
      handleType,
      'int',
      handleType,
      'uint32'
    ]),
    terminateJobObject: bind('TerminateJobObject', 'int', [handleType, 'uint32']),
    extendedLimitInformationSize: extendedLimitInformationType.size,
    limitFlagsOffset: extendedLimitInformationType.members!.basicLimitInformation.offset
      + basicLimitInformationType.members!.limitFlags.offset
  }
  return cachedBindings
}

function isNullHandle(handle: unknown): boolean {
  return handle === null || handle === undefined || handle === 0n
}

function win32Failure(api: string, native: WindowsJobBindings): Error {
  return new Error(`${api} failed (Win32 ${native.getLastError()}).`)
}

export class WindowsProcessJob {
  private handle: unknown
  private readonly native: WindowsJobBindings

  constructor(handle: unknown, native: WindowsJobBindings) {
    this.handle = handle
    this.native = native
  }

  addProcess(processId: number): void {
    if (isNullHandle(this.handle)) throw new Error('The Windows Job Object is closed.')
    if (!Number.isSafeInteger(processId) || processId <= 0) {
      throw new Error('A valid process ID is required for the Windows Job Object.')
    }
    const processHandle = this.native.openProcess(
      processSetQuota | processTerminate,
      0,
      processId
    )
    if (isNullHandle(processHandle)) throw win32Failure('OpenProcess', this.native)
    try {
      if (this.native.assignProcessToJobObject(this.handle, processHandle) === 0) {
        throw win32Failure('AssignProcessToJobObject', this.native)
      }
    } finally {
      this.native.closeHandle(processHandle)
    }
  }

  close(): void {
    if (isNullHandle(this.handle)) return
    const handle = this.handle
    if (this.native.closeHandle(handle) === 0) throw win32Failure('CloseHandle', this.native)
    this.handle = null
  }

  release(): void {
    if (isNullHandle(this.handle)) return
    const information = Buffer.alloc(this.native.extendedLimitInformationSize)
    if (this.native.setInformationJobObject(
      this.handle,
      jobObjectExtendedLimitInformation,
      information,
      information.length
    ) === 0) {
      throw win32Failure('SetInformationJobObject', this.native)
    }
    this.close()
  }

  terminate(exitCode = 1): void {
    if (isNullHandle(this.handle)) return
    if (this.native.terminateJobObject(this.handle, exitCode) === 0) {
      throw win32Failure('TerminateJobObject', this.native)
    }
  }
}

export function createWindowsKillOnCloseJob(): WindowsProcessJob {
  const native = bindings()
  const handle = native.createJobObjectW(null, null)
  if (isNullHandle(handle)) throw win32Failure('CreateJobObjectW', native)

  try {
    const information = Buffer.alloc(native.extendedLimitInformationSize)
    information.writeUInt32LE(jobObjectLimitKillOnJobClose, native.limitFlagsOffset)
    if (native.setInformationJobObject(
      handle,
      jobObjectExtendedLimitInformation,
      information,
      information.length
    ) === 0) {
      throw win32Failure('SetInformationJobObject', native)
    }
    return new WindowsProcessJob(handle, native)
  } catch (error) {
    native.closeHandle(handle)
    throw error
  }
}
