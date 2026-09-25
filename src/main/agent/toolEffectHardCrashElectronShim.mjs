export const app = {
  getPath() {
    throw new Error('The hard-crash fixture must use an explicit database path.')
  }
}
