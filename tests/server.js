const path = require('path')
const Server = require('ws').Server
const Transfer = require('..')

const wss = new Server({ port: 8888 })
wss.on('connection', ws => {
  ws.send('begin transfer')
  ws.on('message', msg => {
    if (typeof msg === 'string') {
      console.log(`Start transferring: ${msg}`)
      Transfer.send(path.resolve(msg), ws, { progress: ({ loaded, total }) => {
        console.log(`Sent ${loaded} bytes`)
      } })
        .then(() => {
          console.log('transfer completed')
        }, err => {
          console.error(err)
        })
    }
  })
})
