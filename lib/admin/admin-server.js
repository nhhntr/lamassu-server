const EventEmitter = require('events')
const qs = require('querystring')
const fs = require('fs')
const path = require('path')
const express = require('express')
const app = express()
const https = require('https')
const bodyParser = require('body-parser')
const serveStatic = require('serve-static')
const cookieParser = require('cookie-parser')
const argv = require('minimist')(process.argv.slice(2))
const got = require('got')
const morgan = require('morgan')
const helmet = require('helmet')
const WebSocket = require('ws')
const http = require('http')
const SocketIo = require('socket.io')

const machineLoader = require('../machine-loader')
const T = require('../time')
const logger = require('../logger')
const options = require('../options')

const accounts = require('./accounts')
const config = require('./config')
const login = require('./login')
const pairing = require('./pairing')
const server = require('./server')
const transactions = require('./transactions')
const funding = require('./funding')

const NEVER = new Date(Date.now() + 100 * T.years)
const REAUTHENTICATE_INTERVAL = T.minute

const devMode = argv.dev

const version = require('../../package.json').version
logger.info('Version: %s', version)

const hostname = options.hostname

if (!hostname) {
  console.error('Error: no hostname specified.')
  process.exit(1)
}

module.exports = {run}

function dbNotify () {
  return got.post('http://localhost:3030/dbChange')
  .catch(e => console.error('Error: lamassu-server not responding'))
}

const skip = (req, res) => req.path === '/api/status/' && res.statusCode === 200

// Note: no rate limiting applied since that would allow an attacker to
// easily DDoS by just hitting the aggregate rate limit. We assume the
// attacker has unlimited unique IP addresses.
//
// The best we can do at the application level is to make the authentication
// lookup very fast. There will only be a few users at most, so it's not a problem
// to keep them in memory, but we need to update right after a new one is added.
// For now, we believe that probability of sustained DDoS by saturating our ability to
// fetch from the DB is pretty low.

app.use(morgan('dev', {skip}))
app.use(helmet({noCache: true}))
app.use(cookieParser())
app.use(register)
app.use(authenticate)

app.use(bodyParser.json())

app.get('/api/totem', (req, res) => {
  const name = req.query.name

  if (!name) return res.status(400).send('Name is required')

  return pairing.totem(hostname, name)
  .then(totem => res.send(totem))
})

app.get('/api/accounts', (req, res) => {
  accounts.selectedAccounts()
  .then(accounts => res.json({accounts: accounts}))
})

app.get('/api/account/:account', (req, res) => {
  accounts.getAccount(req.params.account)
  .then(account => res.json(account))
})

app.post('/api/account', (req, res) => {
  return accounts.updateAccount(req.body)
  .then(account => res.json(account))
  .then(() => dbNotify())
})

app.get('/api/config/:config', (req, res) =>
  config.fetchConfigGroup(req.params.config).then(c => res.json(c)))

app.post('/api/config', (req, res, next) => {
  config.saveConfigGroup(req.body)
  .then(c => res.json(c))
  .then(() => dbNotify())
  .catch(next)
})

app.get('/api/accounts/account/:account', (req, res) => {
  accounts.getAccount(req.params.account)
  .then(r => res.send(r))
})

app.get('/api/machines', (req, res) => {
  machineLoader.getMachineNames()
  .then(r => res.send({machines: r}))
})

app.post('/api/machines', (req, res) => {
  machineLoader.setMachine(req.body)
  .then(() => machineLoader.getMachineNames())
  .then(r => res.send({machines: r}))
  .then(() => dbNotify())
})

app.get('/api/funding', (req, res) => {
  return funding.getFunding()
  .then(r => res.json(r))
})

app.get('/api/funding/:cryptoCode', (req, res) => {
  const cryptoCode = req.params.cryptoCode

  return funding.getFunding(cryptoCode)
  .then(r => res.json(r))
})

app.get('/api/status', (req, res, next) => {
  return Promise.all([server.status(), config.validateCurrentConfig()])
  .then(([serverStatus, invalidConfigGroups]) => res.send({
    server: serverStatus,
    invalidConfigGroups
  }))
  .catch(next)
})

app.get('/api/transactions', (req, res, next) => {
  return transactions.batch()
  .then(r => res.send({transactions: r}))
  .catch(next)
})

app.use((err, req, res, next) => {
  console.error(err)

  return res.status(500).send(err.message)
})

const certOptions = {
  key: fs.readFileSync(options.keyPath),
  cert: fs.readFileSync(options.certPath)
}

app.use(serveStatic(path.resolve(__dirname, '..', '..', 'public')))

function register (req, res, next) {
  const otp = req.query.otp

  if (!otp) return next()

  return login.register(otp)
  .then(r => {
    if (r.expired) return res.status(401).send('OTP expired, generate new registration link')

    // Maybe user is using old registration key, attempt to authenticate
    if (!r.success) return next()

    const cookieOpts = {
      httpOnly: true,
      secure: true,
      domain: hostname,
      sameSite: true,
      expires: NEVER
    }

    const token = r.token
    req.token = token
    res.cookie('token', token, cookieOpts)
    next()
  })
}

function authenticate (req, res, next) {
  const token = req.token || req.cookies.token

  return login.authenticate(token)
  .then(success => {
    if (!success) return res.status(401).send('Authentication failed')
    next()
  })
}

process.on('unhandledRejection', err => {
  console.error(err.stack)
  process.exit(1)
})

const socketServer = http.createServer()
const io = SocketIo(socketServer)
socketServer.listen(3060)
const socketEmitter = new EventEmitter()

io.on('connection', client => {
  client.on('message', msg => socketEmitter.emit('message', msg))
})

const webServer = https.createServer(certOptions, app)
const wss = new WebSocket.Server({server: webServer})

function establishSocket (ws, token) {
  return login.authenticate(token)
  .then(success => {
    if (!success) return ws.close(1008, 'Authentication error')

    const listener = data => {
      console.log('DEBUG200: %j', data)
      ws.send(JSON.stringify(data))
    }

    // Reauthenticate every once in a while, in case token expired
    setInterval(() => {
      return login.authenticate(token)
      .then(success => {
        if (!success) {
          socketEmitter.removeListener('message', listener)
          ws.close()
        }
      })
    }, REAUTHENTICATE_INTERVAL)

    socketEmitter.on('message', listener)

    console.log('DEBUG120: %j', token)
    ws.send('Testing123')
  })
}

wss.on('connection', ws => {
  const token = qs.parse(ws.upgradeReq.headers.cookie).token

  return establishSocket(ws, token)
})

function run () {
  if (devMode) {
    webServer.listen(8070, () => {
      console.log('lamassu-admin-server listening on port 8070')
    })
  } else {
    webServer.listen(443, () => {
      console.log('lamassu-admin-server listening on port 443')
    })
  }
}