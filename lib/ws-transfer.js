const path = require('path')
const fs = require('fs')
const errors = require('./errors')

const { InvalidTypeError, InvalidSeqError, TimeoutError, AbortError, SocketCLosedError, IncompleteError } = errors

const constants = {
  TYPE_START: 1,
  TYPE_DATA: 2,
  TYPE_READY: 3,
  TYPE_FIN: 4,
  TYPE_ABORT: 5,
  TYPE_UNKNOWN: 0
}

const decode = buf => {
  if (buf.length < 9) return null
  // 0    | 1 - 4 | 5 - 8 | rest
  // U8   | U32LE | U32LE | Buffer
  // TYPE | ID    | SEQ   | DATA
  // TYPE: 0 - unknown, 1 - data, 2 - meta, 3 - ready, 4 - abort
  const type = buf.readUInt8(0)
  const id = buf.readUInt32LE(1)
  const seq = buf.readUInt32LE(5)
  const payload = buf.slice(9)
  const meta = type === constants.TYPE_START ? JSON.parse(payload.toString()) : { size: 0 }
  return { type, id, seq, payload, meta }
}

const encode = (type, id, seq = 0, payload = null) => {
  const packet = Buffer.alloc(payload ? payload.length + 9 : 9)
  packet.writeUInt8(type, 0)
  packet.writeUInt32LE(id, 1)
  packet.writeUInt32LE(seq, 5)
  if (payload) payload.copy(packet, 9)
  return packet
}

const packets = {
  start (id, meta = { size: 0 }) {
    const buf = Buffer.from(JSON.stringify(meta), 'utf-8')
    return encode(constants.TYPE_START, id, 0, buf)
  },
  data (id, seq, payload = null) {
    return encode(constants.TYPE_DATA, id, seq, payload)
  },
  ready (id) {
    return encode(constants.TYPE_READY, id)
  },
  abort (id) {
    return encode(constants.TYPE_ABORT, id)
  },
  fin (id) {
    return encode(constants.TYPE_FIN, id)
  }
}

module.exports = {
  constants,
  errors,
  packets,
  listen (ws, onSend) {
    const sendMessageHandler = msg => {
      if (msg instanceof Buffer) {
        const packet = decode(msg)
        if (!packet) return // ignore invalid packet
        if (packet.type === constants.TYPE_START) {
          const { id, meta } = packet
          onSend({ id, meta })
        }
      }
    }
    ws.on('message', sendMessageHandler)
    return () => {
      ws.removeListener('message', sendMessageHandler)
    }
  },
  async receive (pathname, ws, { id, meta = { size: 0 }, stream: isStream = false, timeout = 30000, progress: onProgress = () => {} } = {}) {
    const promise = new Promise((resolve, reject) => {
      let stream
      let lastSeq = 0
      let received = 0
      let ts = Date.now()
      let stopped = false

      const timer = setInterval(() => {
        if (Date.now() - ts >= timeout) {
          stopReceive(new TimeoutError())
        }
      }, 5000)

      // stop receiving packets
      const stopReceive = error => {
        if (stopped) return
        stopped = true
        clearInterval(timer)
        ws.removeListener('message', messageHandler)
        ws.removeListener('close', closeHandler)
        if (stream) stream.removeListener('error', streamErrorHandler)
        // close the stream if created inside
        if (!isStream) try { stream.end() } catch (e) { /* nothing todo */ }
        if (error) {
          // send ABORT to sender
          try { ws.send(packets.abort(id)) } catch (e) { /* nothing todo */ }
          if (isStream) return reject(error)
          fs.unlink(pathname, () => {
            reject(error)
          })
          return
        }
        resolve(pathname)
      }

      const messageHandler = msg => {
        if (msg instanceof Buffer) {
          const packet = decode(msg)
          if (!packet) return // skip invalid packet
          const { type, id: thisId, seq, payload } = packet
          if (thisId !== id) return // skip non-matching transfers
          // abort transfer when ABORT packet received
          if (type === constants.TYPE_ABORT) return stopReceive(new AbortError())
          // stop transfer when finished
          if (type === constants.TYPE_FIN) {
            // incomplete transfer when file size not match
            if (meta && meta.size && meta.size !== received) {
              return stopReceive(new IncompleteError())
            }
            // transfer stopped normally
            return stopReceive()
          }
          if (type !== constants.TYPE_DATA) return // skip packets other than DATA
          if (seq !== lastSeq + 1) return stopReceive(new InvalidSeqError()) // check SEQ
          const size = (meta && meta.size) || 0
          lastSeq = seq
          ts = Date.now()
          received += payload.length
          stream.write(payload)
          onProgress({ lengthComputable: !!size, loaded: received, total: size })
        }
      }
      const closeHandler = () => stopReceive(new SocketCLosedError())
      const streamErrorHandler = err => stopReceive(err)
      // promise.abort = () => stopReceive(new AbortError())

      try {
        // create stream if a path is given
        stream = isStream ? pathname : fs.createWriteStream(pathname)
        stream.on('error', streamErrorHandler)
        ws.on('message', messageHandler)
        ws.on('close', closeHandler)
        // send READY to sender
        ws.send(packets.ready(id))
      } catch (e) {
        reject(e)
      }
    })
    return promise
  },
  async send (pathname, ws, { id = Math.floor(Date.now() / 1000), stream: isStream = false, meta = null, timeout = 30000, progress: onProgress = () => {} } = {}) {
    const promise = new Promise((resolve, reject) => {
      let stream
      let seq = 0
      let ts = Date.now()
      let stopped = false
      let sent = 0

      const timer = setInterval(() => {
        if (Date.now() - ts >= timeout) {
          stopSend(new TimeoutError())
        }
      }, 5000)

      const stopSend = error => {
        if (stopped) return
        stopped = true
        clearInterval(timer)
        ws.removeListener('message', messageHandler)
        ws.removeListener('close', closeHandler)
        if (stream) {
          stream.removeListener('error', streamErrorHandler)
          stream.removeListener('end', streamEndHandler)
          stream.removeListener('data', streamDataHandler)
        }
        if (error) {
          // close self created stream
          if (!isStream) try { stream.close() } catch (e) { /* do nothing */ }
          // send ABORT to receiver
          try { ws.send(packets.abort(id)) } catch (e) { /* do nothing */ }
          return reject(error)
        }
        // send FIN to receiver
        try { ws.send(packets.fin(id)) } catch (e) { /* do nothing */ }
        resolve(pathname)
      }

      const messageHandler = msg => {
        if (msg instanceof Buffer) {
          const packet = decode(msg)
          if (!packet) return // ignore invalid packet
          const { type, id: thisId } = packet
          if (thisId !== id) return
          // abort transfer when received abort
          if (type === constants.TYPE_ABORT) return stopSend(new AbortError())
          // expecting ready and start to send
          if (type !== constants.TYPE_READY) return stopSend(new InvalidTypeError())
          // check SEQ
          if (seq !== 0) throw stopSend(new InvalidSeqError())
          try {
            seq = 1
            stream = isStream ? pathname : fs.createReadStream(pathname)
            stream.on('error', streamErrorHandler)
            stream.on('data', streamDataHandler)
            stream.on('end', streamEndHandler)
            ts = Date.now()
          } catch (e) {
            stopSend(e)
          }
        }
      }
      const closeHandler = () => stopSend(new SocketCLosedError())
      const streamErrorHandler = err => stopSend(err)
      const streamDataHandler = data => {
        const size = (meta && meta.size) || 0
        sent += data.length
        ts = Date.now()
        ws.send(packets.data(id, seq++, data))
        onProgress({ lengthComputable: !!size, loaded: sent, total: size })
      }
      const streamEndHandler = () => {
        // throw incomplete transfer if size not match
        if (meta && meta.size && meta.size !== sent) stopSend(new IncompleteError())
        else stopSend()
      }
      const sendStart = () => {
        try {
          // 1 - send start to remote
          ws.send(packets.start(id, meta))
        } catch (e) {
          stopSend(e)
        }
      }
      // promise.end = () => stopSend()
      // promise.abort = () => ws.send(packets.abort(id))

      ws.on('message', messageHandler)
      ws.on('close', closeHandler)

      if (!isStream && !meta) {
        fs.stat(pathname, (err, stat) => {
          if (err) return stopSend(err)
          meta = { size: stat.size, filename: path.basename(pathname) }
          sendStart()
        })
      } else {
        sendStart()
      }
    })
    return promise
  }
}
