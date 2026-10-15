require('dotenv').config({ path: require('path').join(__dirname, '../../.env') })

const mongoose = require('mongoose')
const { Point } = require('@influxdata/influxdb-client')
const TelemetryReading = require('../models/TelemetryReading')
const influx = require('../services/influx')

const BATCH_SIZE = 5000

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('Connected to MongoDB')

  const total = await TelemetryReading.countDocuments()
  console.log(`Total readings to migrate: ${total}`)

  let processed = 0
  let skipped = 0

  while (processed < total) {
    const batch = await TelemetryReading.find({})
      .sort({ arrivedAt: 1 })
      .skip(processed)
      .limit(BATCH_SIZE)
      .lean()

    if (batch.length === 0) break

    for (const doc of batch) {
      const tagId = doc.tagId?.toString()
      if (!tagId) { skipped++; continue }
      const point = new Point('telemetry_reading')
        .tag('tagId', tagId)
        .tag('companyId', (doc.companyId || '').toString())
        .tag('gatewayId', (doc.gatewayId || '').toString())
        .floatField('value', doc.value)
        .timestamp(new Date(doc.arrivedAt))
      influx.writeApi.writePoint(point)
    }

    await influx.flush()
    processed += batch.length
    console.log(`Progress: ${processed}/${total} (${((processed / total) * 100).toFixed(1)}%)`)
  }

  console.log(`Migration complete. Processed: ${processed}, Skipped: ${skipped}`)
  await mongoose.disconnect()
}

migrate().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
