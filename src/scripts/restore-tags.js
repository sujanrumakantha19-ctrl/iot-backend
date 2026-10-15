const mongoose = require('mongoose')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../../.env') })

const Gateway = require('../models/Gateway')
const GatewayConfig = require('../models/GatewayConfig')
const TelemetryTag = require('../models/TelemetryTag')
const Company = require('../models/Company')

async function restoreTags() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/iot-platform')
    console.log('Connected to DB')

    const gateways = await Gateway.find()
    let restoredCount = 0

    for (const gw of gateways) {
      const config = await GatewayConfig.findOne({ gatewayId: gw._id }).sort({ createdAt: -1 })
      if (!config) continue

      const company = await Company.findById(gw.companyId)
      if (!company) continue

      const allRows = config.rows || []
      if (allRows.length === 0) continue

      for (const r of allRows) {
        const pName = (r.parameterName || '').replace(/^[tp](\d+)$/i, 'P$1')
        const topicName = r.topicName ? r.topicName.replace(/^[tp](\d+)$/i, 'P$1') : pName
        const telemetryTopic = `${company.slug}/${gw.prefix}/${topicName.toLowerCase()}`

        const existing = await TelemetryTag.findOne({ telemetryTopic })
        if (!existing) {
          await TelemetryTag.create({
            companyId: company._id,
            gatewayId: gw._id,
            parameterName: pName,
            topicName: topicName,
            displayName: r.displayName || pName,
            deviceName: r.deviceName,
            unit: r.unit || '',
            telemetryTopic: telemetryTopic,
            warningThreshold: r.warningThreshold || null,
            criticalThreshold: r.criticalThreshold || null,
            alertsEnabled: true
          })
          restoredCount++
          console.log(`Restored tag: ${telemetryTopic}`)
        }
      }
    }
    console.log(`Successfully restored ${restoredCount} missing tags.`)
    process.exit(0)
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

restoreTags()
