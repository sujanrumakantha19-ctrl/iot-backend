const mongoose = require('mongoose')
const Company = require('../models/Company')
const User = require('../models/User')
const Gateway = require('../models/Gateway')
const GatewayConfig = require('../models/GatewayConfig')
const TelemetryTag = require('../models/TelemetryTag')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class BackupSyncManager {
  constructor() {
    this.status = 'idle' // 'idle' | 'running' | 'paused' | 'completed' | 'failed'
    this.progress = 0
    this.activeCollection = ''
    this.copiedCount = 0
    this.totalCount = 0
    this.localUri = ''
    this.isPaused = false
    this.errorMessage = ''
    this.io = null
    this.startTime = null
    this.writeSpeed = 0 // documents per second
    this.writeSpeedKB = 0 // estimated KB per second
  }

  emitUpdate() {
    if (this.io) {
      this.io.to('admins').emit('backup:sync-progress', this.getState())
    }
  }

  getState() {
    return {
      status: this.status,
      progress: Math.round(this.progress),
      activeCollection: this.activeCollection,
      copiedCount: this.copiedCount,
      totalCount: this.totalCount,
      isPaused: this.isPaused,
      errorMessage: this.errorMessage,
      writeSpeed: this.writeSpeed,
      writeSpeedKB: this.writeSpeedKB
    }
  }

  async pause() {
    if (this.status === 'running') {
      this.isPaused = true
      this.status = 'paused'
      console.log('[Backup Sync] Paused')
      this.emitUpdate()
    }
  }

  async resume() {
    if (this.status === 'paused') {
      this.isPaused = false
      this.status = 'running'
      console.log('[Backup Sync] Resumed')
      this.emitUpdate()
    }
  }

  async stop() {
    this.status = 'idle'
    this.progress = 0
    this.copiedCount = 0
    this.totalCount = 0
    this.activeCollection = ''
    this.isPaused = false
    this.writeSpeed = 0
    this.writeSpeedKB = 0
    console.log('[Backup Sync] Stopped & Reset')
    this.emitUpdate()
  }

  async start(localUri, io) {
    if (this.status === 'running' || this.status === 'paused') {
      return
    }

    this.localUri = localUri
    this.io = io
    this.status = 'running'
    this.progress = 0
    this.copiedCount = 0
    this.isPaused = false
    this.errorMessage = ''
    this.writeSpeed = 0
    this.writeSpeedKB = 0
    this.startTime = Date.now()
    this.emitUpdate()

    // Run sync in background
    this.runSync()
  }

  async runSync() {
    let targetConn = null
    try {
      // 1. Get total counts
      const counts = {
        companies: await Company.countDocuments(),
        users: await User.countDocuments(),
        gateways: await Gateway.countDocuments(),
        configs: await GatewayConfig.countDocuments(),
        tags: await TelemetryTag.countDocuments()
      }

      this.totalCount = Object.values(counts).reduce((a, b) => a + b, 0)
      if (this.totalCount === 0) {
        this.status = 'completed'
        this.progress = 100
        this.emitUpdate()
        return
      }

      console.log(`[Backup Sync] Starting sync. Total documents to copy: ${this.totalCount}`)

      // Reset start time to accurately calculate throughput speed
      this.startTime = Date.now()

      // 2. Establish temporary connection to destination database
      targetConn = mongoose.createConnection(this.localUri, {
        serverSelectionTimeoutMS: 5000
      })
      await targetConn.asPromise()

      // Define target models dynamically on target connection
      const TargetModels = {
        Company: targetConn.model('Company', Company.schema),
        User: targetConn.model('User', User.schema),
        Gateway: targetConn.model('Gateway', Gateway.schema),
        GatewayConfig: targetConn.model('GatewayConfig', GatewayConfig.schema),
        TelemetryTag: targetConn.model('TelemetryTag', TelemetryTag.schema)
      }

      // Collections list to copy
      const collections = [
        { name: 'Companies', sourceModel: Company, targetModel: TargetModels.Company },
        { name: 'Users', sourceModel: User, targetModel: TargetModels.User },
        { name: 'Gateways', sourceModel: Gateway, targetModel: TargetModels.Gateway },
        { name: 'GatewayConfigs', sourceModel: GatewayConfig, targetModel: TargetModels.GatewayConfig },
        { name: 'TelemetryTags', sourceModel: TelemetryTag, targetModel: TargetModels.TelemetryTag }
      ]

      // 3. Sync collections sequentially using Keyset Pagination (Cursor based) for optimal efficiency on large data
      for (const col of collections) {
        if (this.status === 'idle') break // Stopped externally

        this.activeCollection = col.name
        this.emitUpdate()

        // Clear target collection first for clean copy
        try {
          await col.targetModel.deleteMany({})
        } catch (e) {
          console.warn(`[Backup Sync] Could not clear collection ${col.name}:`, e.message)
        }

        // Keyset Pagination loop
        const batchSize = 250 // Increased batch size for optimized chunking
        let lastId = null
        let hasMore = true

        while (hasMore) {
          // Check state
          if (this.status === 'idle') break

          // If paused, wait until resumed or stopped
          while (this.isPaused) {
            if (this.status === 'idle') break
            await sleep(500)
          }

          if (this.status === 'idle') break

          // Keyset Pagination query: fetch documents with _id > lastId
          const query = lastId ? { _id: { $gt: lastId } } : {}
          const docs = await col.sourceModel.find(query).sort({ _id: 1 }).limit(batchSize).lean()

          if (docs.length === 0) {
            hasMore = false
            break
          }

          // Insert batch into target connection database
          await col.targetModel.insertMany(docs)

          // Update pagination cursor to last document _id in the batch
          lastId = docs[docs.length - 1]._id

          this.copiedCount += docs.length
          this.progress = (this.copiedCount / this.totalCount) * 100

          // Calculate running speeds (docs/sec and estimated KB/sec)
          const elapsedSec = (Date.now() - this.startTime) / 1000
          if (elapsedSec > 0) {
            this.writeSpeed = Math.round(this.copiedCount / elapsedSec)
            // Estimate average doc size around 1.5 KB
            this.writeSpeedKB = Math.round((this.copiedCount * 1.5) / elapsedSec)
          }

          this.emitUpdate()

          // Minimal throttle block to allow other loop tasks to breathe
          await sleep(50) 
        }
      }

      if (this.status !== 'idle') {
        this.status = 'completed'
        this.progress = 100
        this.emitUpdate()
        console.log('[Backup Sync] Completed successfully!')
      }

    } catch (err) {
      console.error('[Backup Sync] Error:', err.message)
      this.status = 'failed'
      this.errorMessage = err.message
      this.emitUpdate()
    } finally {
      if (targetConn) {
        try {
          await targetConn.close()
          console.log('[Backup Sync] Target connection closed.')
        } catch (e) {
          console.error('[Backup Sync] Error closing target connection:', e.message)
        }
      }
    }
  }
}

module.exports = new BackupSyncManager()
