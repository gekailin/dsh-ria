// One config gate shared by every automatic-pause path. A read failure is
// intentionally fail-closed: never introduce a pause the user did not enable.
export function isAutoPauseEnabled(read) {
  if (typeof read !== 'function') return true
  return read() === true
}
