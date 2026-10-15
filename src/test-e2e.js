require('dotenv').config()
const mongoose = require('mongoose')
const Company = require('./models/Company')
const User = require('./models/User')
const Gateway = require('./models/Gateway')
const TelemetryTag = require('./models/TelemetryTag')
const TelemetryReading = require('./models/TelemetryReading')

const runTest = async () => {
  try {
    console.log('Connecting to MongoDB...')
    await mongoose.connect(process.env.MONGODB_URI)
    console.log('Connected to MongoDB.')

    // 1. Verify default seeded data
    const acme = await Company.findOne({ slug: 'acme-corp' })
    if (!acme) throw new Error('Acme Corp company not found. Seed the database first!')
    console.log('ACME Corp found:', acme._id)

    const gateway = await Gateway.findOne({ prefix: 'gw-alpha' })
    if (!gateway) throw new Error('Gateway Alpha not found.')
    console.log('Gateway Alpha found:', gateway._id)

    const tag = await TelemetryTag.findOne({ telemetryTopic: 'acme-corp/gw-alpha/Temperature' })
    if (!tag) throw new Error('TelemetryTag "Temperature" not found.')
    console.log('Telemetry Tag found:', tag._id)

    // 2. Simulate Telemetry Ingestion (directly executing model logic)
    console.log('\n--- Simulating Telemetry Ingestion Pipeline ---')
    const testValue = 32.4
    const arrivedAt = new Date()

    // Create TelemetryReading record
    const reading = await TelemetryReading.create({
      companyId: tag.companyId,
      gatewayId: tag.gatewayId,
      tagId: tag._id,
      telemetryTopic: tag.telemetryTopic,
      value: testValue,
      arrivedAt
    })
    console.log('✔ TelemetryReading record created in DB.')

    // Update TelemetryTag latestValue and latestArrivedAt
    tag.latestValue = testValue
    tag.latestArrivedAt = arrivedAt
    await tag.save()
    console.log('✔ TelemetryTag latestValue snapshot updated.')

    // Update Gateway lastSeenAt
    await Gateway.findByIdAndUpdate(tag.gatewayId, { lastSeenAt: arrivedAt })
    console.log('✔ Gateway lastSeenAt updated.')

    // 3. Verify Database Persistence
    const latestReading = await TelemetryReading.findOne({ tagId: tag._id }).sort({ arrivedAt: -1 })
    if (!latestReading || latestReading.value !== testValue) {
      throw new Error(`Expected value ${testValue}, got ${latestReading ? latestReading.value : 'none'}`)
    }
    console.log('✔ Database Persistence validation: PASSED.')

    const updatedTag = await TelemetryTag.findById(tag._id)
    if (!updatedTag || updatedTag.latestValue !== testValue) {
      throw new Error(`Expected tag value ${testValue}, got ${updatedTag ? updatedTag.latestValue : 'none'}`)
    }
    console.log('✔ Tag Snapshot cache validation: PASSED.')

    console.log('\nALL E2E DATA PIPELINE SIMULATION TESTS PASSED SUCCESSFULLY!')
    process.exit(0)
  } catch (error) {
    console.error('\nE2E TEST FAILED:', error.message)
    process.exit(1)
  }
}

runTest()
