const router = require('express').Router()
const createError = require('http-errors')
const mongoose = require('mongoose')
const { authenticate, authorizeRoles } = require('../middleware/auth')

const authRoutes = require('./auth')
const adminRoutes = require('./admin')
const managerRoutes = require('./manager')
const employeeRoutes = require('./employee')
const gatewaysRoutes = require('./gateways')
const Firmware = require('../models/Firmware')

router.get('/', (req, res) => {
  res.json({ success: true, message: 'Backend is running!' })
})

router.get('/health', (req, res) => {
  res.json({ success: true, status: 'OK', timestamp: new Date().toISOString() })
})

// System status — DB size, read/write ops, MQTT state
router.get('/system-status', authenticate, async (req, res, next) => {
  try {
    const db = mongoose.connection.db
    const serverStatus = await db.command({ serverStatus: 1 })
    const dbStats = await db.command({ dbStats: 1 })

    // Data size in human-readable MB
    const dataSizeBytes = dbStats.dataSize || 0
    const dataSizeMB = (dataSizeBytes / 1024 / 1024).toFixed(2)

    // opcounters give total cumulative counts; we return raw for frontend to delta-diff
    const opcounters = serverStatus.opcounters || {}

    // MQTT client state: 0=connecting, 1=connected, 2=reconnecting, 3=closed
    const mqttClient = req.app.locals.mqttClient
    const mqttConnected = mqttClient ? mqttClient.connected : false

    res.json({
      success: true,
      dbSizeMB: parseFloat(dataSizeMB),
      reads: opcounters.query || 0,
      writes: (opcounters.insert || 0) + (opcounters.update || 0) + (opcounters.delete || 0),
      mqttConnected
    })
  } catch (err) {
    next(err)
  }
})

// Mount Auth routes
router.use('/auth', authRoutes)

// Public FOTA firmware download endpoint
router.get('/fota/download/:id', async (req, res, next) => {
  try {
    const firmware = await Firmware.findById(req.params.id)
    if (!firmware) throw createError(404, 'Firmware not found')

    res.set({
      'Content-Type': firmware.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${firmware.filename}"`,
      'Content-Length': firmware.data.length
    })

    res.send(firmware.data)
  } catch (error) {
    next(error)
  }
})

const activityLogsRoutes = require('./activityLogs')

// Mount protected routes
router.use('/admin/activity-logs', authenticate, authorizeRoles('admin'), activityLogsRoutes)
router.use('/admin', authenticate, authorizeRoles('admin'), adminRoutes)
router.use('/manager', authenticate, authorizeRoles('manager'), managerRoutes)
router.use('/employee', authenticate, authorizeRoles('employee'), employeeRoutes)
router.use('/gateways', authenticate, gatewaysRoutes)

router.use((req, res, next) => {
  next(createError(404, 'Route not found'))
})

module.exports = router
