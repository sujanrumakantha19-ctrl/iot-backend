const mongoose = require('mongoose')

const fixTelemetryTagCapitalization = async () => {
  try {
    const TelemetryTag = require('../models/TelemetryTag')
    const GatewayConfig = require('../models/GatewayConfig')

    const tags = await TelemetryTag.find({})
    for (const tag of tags) {
      let updated = false
      if (tag.parameterName && /^p\d+/i.test(tag.parameterName)) {
        const capParam = tag.parameterName.replace(/^p(\d+)/i, 'P$1')
        if (tag.parameterName !== capParam) {
          tag.parameterName = capParam
          updated = true
        }
      }
      if (tag.topicName && /^p\d+/i.test(tag.topicName)) {
        const capTopic = tag.topicName.replace(/^p(\d+)/i, 'P$1')
        if (tag.topicName !== capTopic) {
          tag.topicName = capTopic
          updated = true
        }
      }
      if (updated) {
        await tag.save()
      }
    }

    const configs = await GatewayConfig.find({})
    for (const conf of configs) {
      let updated = false
      if (conf.rows && Array.isArray(conf.rows)) {
        conf.rows.forEach(r => {
          if (r.parameterName && /^p\d+/i.test(r.parameterName)) {
            const cap = r.parameterName.replace(/^p(\d+)/i, 'P$1')
            if (r.parameterName !== cap) {
              r.parameterName = cap
              updated = true
            }
          }
        })
      }
      if (conf.groups && Array.isArray(conf.groups)) {
        conf.groups.forEach(g => {
          if (g.rows && Array.isArray(g.rows)) {
            g.rows.forEach(r => {
              if (r.parameterName && /^p\d+/i.test(r.parameterName)) {
                const cap = r.parameterName.replace(/^p(\d+)/i, 'P$1')
                if (r.parameterName !== cap) {
                  r.parameterName = cap
                  updated = true
                }
              }
            })
          }
        })
      }
      if (updated) {
        await conf.save()
      }
    }
  } catch (err) {
    console.error('[DB] Error auto-fixing parameter capitalization:', err.message)
  }
}

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 10
    })
    console.log(`MongoDB connected: ${conn.connection.host}`)
    fixTelemetryTagCapitalization().catch(() => {})
  } catch (error) {
    console.error(`MongoDB connection error: ${error.message}`)
    process.exit(1)
  }
}

module.exports = connectDB
