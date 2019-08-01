const url = require('url')
const path = require('path')
const WebSocket = require('ws')
const Transfer = require('..')

const pathname = process.argv[2]
const filename = path.basename(pathname)

// eslint-disable-next-line node/no-deprecated-api
const ws = new WebSocket(url.parse('ws://localhost:8888'))
const removeListener = Transfer.listen(ws, ({ id, meta }) => {
  Transfer.receive(path.resolve(__dirname, 'out', filename), ws, { id,
    meta,
    progress: ({ loaded, total }) => {
      console.log(`received ${loaded}`)
    } })
    .then(() => {
      console.log('transfer completed')
    }, err => {
      console.error(err)
    })
    .finally(() => {
      removeListener()
      ws.close()
    })
})
ws.on('open', () => {
  ws.send(pathname)
})
