// GPU/renderer startup failures can leave Playwright evaluation and Electron's
// graceful shutdown waiting forever. Close only the child owned by this test.
async function closeElectronTestApplication(application, release) {
  if (!application) return
  const child = application.process()
  const within = async (operation) => {
    let timer
    try {
      await Promise.race([Promise.resolve().then(operation), new Promise((resolve) => { timer = setTimeout(resolve, 5000) })]).catch(() => undefined)
    } finally { clearTimeout(timer) }
  }
  if (release) await within(release)
  await within(() => application.close())
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await within(() => exited)
  }
}

module.exports = { closeElectronTestApplication }
