import { describe, expect, it } from 'vitest'
import { windowsDetachedProcessCreateScript } from './windowsDetachedShellSupervisor'

describe('windowsDetachedProcessCreateScript', () => {
  it('creates the detached supervisor without allocating a visible console window', () => {
    const script = windowsDetachedProcessCreateScript()

    expect(script).toContain("([wmiclass]'Win32_ProcessStartup').CreateInstance()")
    expect(script).toContain('$startup.ShowWindow = 0')
    expect(script).toContain(
      "([wmiclass]'Win32_Process').Create($env:ANAS_DETACHED_SUPERVISOR_COMMAND, $null, $startup)"
    )
  })
})
