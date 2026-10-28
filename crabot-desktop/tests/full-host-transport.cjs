const { createInterface } = require('node:readline')

module.exports = function controlReader(input) {
  const reader = createInterface({ input })
  // The socket's owner handles/reports transport errors. readline forwards the
  // same error too, including the expected Windows reset after a forced GUI exit.
  reader.on('error', () => {})
  return reader
}
