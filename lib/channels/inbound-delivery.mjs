// Inbound phone messages should join the turn that is already running when Ria
// is busy, and start a normal turn when it is idle. steer() itself does not
// reject an idle session (the host would simply open a new turn), so the mode
// decision has to come from the caller's busy signal.
//
// A steer that throws is retried once as a queue prompt with the same
// requestId. The host de-duplicates prompts by requestId, so a partially
// accepted steer cannot be delivered twice.
export async function deliverInboundPrompt({
  sessionController,
  sessionId,
  content,
  requestId,
  isRiaBusy,
  signal,
  log,
  channel,
}) {
  const label = channel || 'inbound'
  const write = typeof log === 'function' ? log : () => {}
  const messageOf = error => String(error && error.message ? error.message : error)
  let busy = false
  if (typeof isRiaBusy === 'function') {
    try {
      busy = Boolean(isRiaBusy())
    } catch (error) {
      write('warn', '[' + label + ' inbound] busy probe failed; treating Ria as idle: ' + messageOf(error))
    }
  }

  if (!busy) {
    write('info', '[' + label + ' inbound] mode=queue reason=ria_idle requestId=' + requestId)
    await sessionController.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content,
    }, signal)
    return 'queue'
  }

  write('info', '[' + label + ' inbound] mode=steer reason=ria_busy requestId=' + requestId)
  try {
    await sessionController.prompt({
      requestId,
      sessionId,
      mode: 'steer',
      content,
    }, signal)
    return 'steer'
  } catch (error) {
    write('warn', '[' + label + ' inbound] mode=steer failed; retrying once as queue requestId=' + requestId + ': ' + messageOf(error))
  }

  write('info', '[' + label + ' inbound] mode=queue reason=steer_failed requestId=' + requestId)
  await sessionController.prompt({
    requestId,
    sessionId,
    mode: 'queue',
    content,
  }, signal)
  return 'queue'
}
