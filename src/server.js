require('dotenv').config()
require('express-async-errors')

const express = require('express')
const http = require('http')
const { Worker } = require('worker_threads')
const path = require('path')
const cors = require('cors')
const morgan = require('morgan')
const helmet = require('helmet')
const compression = require('compression')
const connectDB = require('./config/db')
const connectMQTT = require('./config/mqtt')
const errorHandler = require('./middleware/errorHandler')
const routes = require('./routes')
const { startDashboardStatsJob } = require('./jobs/dashboardStats')

const app = express()
const server = http.createServer(app)
const PORT = process.env.PORT || 5000

// Spawn the standalone Socket.IO server on a separate CPU thread
const socketWorker = new Worker(path.join(__dirname, 'socketWorker.js'))

socketWorker.on('error', (err) => {
  console.error('[Socket Worker Error]:', err.message)
})

socketWorker.on('exit', (code) => {
  console.log(`[Socket Worker Exit]: Worker exited with code ${code}`)
})

// Lightweight proxy so that the main thread Express routes and MQTT can emit events through the worker
const io = {
  configReadExpectations: new Map(),
  to(room) {
    return {
      emit: (event, data) => {
        socketWorker.postMessage({ type: 'emit', room, event, data })
      }
    }
  },
  emit: (event, data) => {
    socketWorker.postMessage({ type: 'emit', event, data })
  }
}

app.use(helmet())
app.use(cors({ exposedHeaders: ['Content-Disposition'] }))
app.use(compression())
app.use(morgan('dev'))
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

// Make Socket.IO available to req handlers
app.locals.io = io

app.use('/api', routes)

app.use(errorHandler)

// Socket.IO Room routing handler is now delegated entirely to socketWorker.js running on port 4000

const start = async () => {
  await connectDB()
  const { syncAllTagsFromConfig } = require('./services/tagSync')
  await syncAllTagsFromConfig()
  const mqttClient = connectMQTT(io)
  app.locals.mqttClient = mqttClient

  startDashboardStatsJob(600000)

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
  })
}

start()
