class InvalidTypeError extends Error {
  constructor () {
    super('invalid_type')
  }
}

class InvalidSeqError extends Error {
  constructor () {
    super('invalid_seq')
  }
}

class TimeoutError extends Error {
  constructor () {
    super('transfer_timeout')
  }
}

class AbortError extends Error {
  constructor () {
    super('transfer_abort')
  }
}

class SocketCLosedError extends Error {
  constructor () {
    super('socket_closed')
  }
}

class IncompleteError extends Error {
  constructor () {
    super('transfer_incomplete')
  }
}

exports.InvalidTypeError = InvalidTypeError
exports.InvalidSeqError = InvalidSeqError
exports.TimeoutError = TimeoutError
exports.AbortError = AbortError
exports.SocketCLosedError = SocketCLosedError
exports.IncompleteError = IncompleteError
