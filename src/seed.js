require('dotenv').config()
const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const Company = require('./models/Company')
const User = require('./models/User')
const Gateway = require('./models/Gateway')
const TelemetryTag = require('./models/TelemetryTag')
const TelemetryReading = require('./models/TelemetryReading')

const seed = async () => {
  try {
    console.log('Connecting to MongoDB...')
    await mongoose.connect(process.env.MONGODB_URI)
    console.log('Connected to MongoDB.')

    // Clear existing collections
    console.log('Clearing existing data...')
    await Company.deleteMany({})
    await User.deleteMany({})
    await Gateway.deleteMany({})
    await TelemetryTag.deleteMany({})
    await TelemetryReading.deleteMany({})
    console.log('Data cleared.')

    const salt = await bcrypt.genSalt(10)
    const passwordHash = await bcrypt.hash('12345678', salt)

    const seedDemo = process.env.SEED_DEMO_DATA === 'true'

    if (seedDemo) {
      console.log('Seeding COMPLETE demo data (SEED_DEMO_DATA=true)...')
      const acme = await Company.create({ name: 'Acme Corp', slug: 'acme-corp', description: 'Industrial IoT solutions provider' })
      const globex = await Company.create({ name: 'Globex Inc', slug: 'globex-inc', description: 'Smart manufacturing systems' })
      const initech = await Company.create({ name: 'Initech', slug: 'initech', description: 'Connected devices & telemetry' })

      const admin = await User.create({ name: 'Admin User', email: 'admin@gmail.com', passwordHash, role: 'admin', active: true })
      
      const johnManager = await User.create({ name: 'John Manager', email: 'manager@gmail.com', passwordHash, role: 'manager', companyId: acme._id, active: true })
      const sarahConnor = await User.create({ name: 'Sarah Connor', email: 'sarah@acme.com', passwordHash, role: 'manager', companyId: acme._id, active: true })
      const mikeRoss = await User.create({ name: 'Mike Ross', email: 'mike@globex.com', passwordHash, role: 'manager', companyId: globex._id, active: true })
      const lisaChen = await User.create({ name: 'Lisa Chen', email: 'lisa@initech.com', passwordHash, role: 'manager', companyId: initech._id, active: true })

      const gw1 = await Gateway.create({ companyId: acme._id, name: 'Gateway Alpha', prefix: 'gw-alpha', location: 'Building A, Floor 1', status: 'online' })
      const gw2 = await Gateway.create({ companyId: acme._id, name: 'Gateway Beta', prefix: 'gw-beta', location: 'Building A, Floor 2', status: 'online' })
      const gw3 = await Gateway.create({ companyId: acme._id, name: 'Gateway Gamma', prefix: 'gw-gamma', location: 'Building B, Floor 1', status: 'offline' })
      const gw4 = await Gateway.create({ companyId: globex._id, name: 'Gateway Delta', prefix: 'gw-delta', location: 'Plant 1, Main Hall', status: 'online' })
      const gw5 = await Gateway.create({ companyId: globex._id, name: 'Gateway Epsilon', prefix: 'gw-epsilon', location: 'Plant 1, Storage', status: 'online' })
      const gw6 = await Gateway.create({ companyId: initech._id, name: 'Gateway Zeta', prefix: 'gw-zeta', location: 'Lab 3, Rack 4', status: 'online' })

      const t1 = await TelemetryTag.create({ companyId: acme._id, gatewayId: gw1._id, topicName: 'Temperature', telemetryTopic: 'acme-corp/gw-alpha/Temperature', parameterName: 'P1', deviceName: 'SensorA', unit: '°C' })
      const t2 = await TelemetryTag.create({ companyId: acme._id, gatewayId: gw1._id, topicName: 'Humidity', telemetryTopic: 'acme-corp/gw-alpha/Humidity', parameterName: 'P2', deviceName: 'SensorA', unit: '%' })
      const t3 = await TelemetryTag.create({ companyId: acme._id, gatewayId: gw2._id, topicName: 'Pressure', telemetryTopic: 'acme-corp/gw-beta/Pressure', parameterName: 'P1', deviceName: 'SensorB', unit: 'kPa' })
      const t4 = await TelemetryTag.create({ companyId: acme._id, gatewayId: gw2._id, topicName: 'Vibration', telemetryTopic: 'acme-corp/gw-beta/Vibration', parameterName: 'P2', deviceName: 'SensorB', unit: 'mm/s' })
      const t5 = await TelemetryTag.create({ companyId: acme._id, gatewayId: gw3._id, topicName: 'FlowRate', telemetryTopic: 'acme-corp/gw-gamma/FlowRate', parameterName: 'P1', deviceName: 'SensorC', unit: 'L/min' })
      const t6 = await TelemetryTag.create({ companyId: globex._id, gatewayId: gw4._id, topicName: 'Temperature', telemetryTopic: 'globex-inc/gw-delta/Temperature', parameterName: 'P1', deviceName: 'SensorD', unit: '°C' })
      const t7 = await TelemetryTag.create({ companyId: globex._id, gatewayId: gw4._id, topicName: 'RPM', telemetryTopic: 'globex-inc/gw-delta/RPM', parameterName: 'P2', deviceName: 'SensorD', unit: 'rpm' })
      const t8 = await TelemetryTag.create({ companyId: globex._id, gatewayId: gw5._id, topicName: 'Voltage', telemetryTopic: 'globex-inc/gw-epsilon/Voltage', parameterName: 'P1', deviceName: 'SensorE', unit: 'V' })
      const t9 = await TelemetryTag.create({ companyId: globex._id, gatewayId: gw5._id, topicName: 'Current', telemetryTopic: 'globex-inc/gw-epsilon/Current', parameterName: 'P2', deviceName: 'SensorE', unit: 'A' })
      const t10 = await TelemetryTag.create({ companyId: initech._id, gatewayId: gw6._id, topicName: 'Temperature', telemetryTopic: 'initech/gw-zeta/Temperature', parameterName: 'P1', deviceName: 'SensorF', unit: '°C' })

      const janeEmployee = await User.create({
        name: 'Jane Employee',
        email: 'employee@gmail.com',
        passwordHash,
        role: 'employee',
        companyId: acme._id,
        managerId: johnManager._id,
        assignedGatewayIds: [gw1._id, gw2._id],
        assignedTagIds: [t1._id, t2._id, t3._id, t4._id],
        active: true
      })
      const bobSmith = await User.create({
        name: 'Bob Smith',
        email: 'bob@acme.com',
        passwordHash,
        role: 'employee',
        companyId: acme._id,
        managerId: johnManager._id,
        assignedGatewayIds: [gw1._id],
        assignedTagIds: [t1._id, t2._id],
        active: true
      })
      const aliceWong = await User.create({
        name: 'Alice Wong',
        email: 'alice@acme.com',
        passwordHash,
        role: 'employee',
        companyId: acme._id,
        managerId: sarahConnor._id,
        assignedGatewayIds: [gw2._id, gw3._id],
        assignedTagIds: [t3._id, t4._id, t5._id],
        active: true
      })
      const tomHardy = await User.create({
        name: 'Tom Hardy',
        email: 'tom@globex.com',
        passwordHash,
        role: 'employee',
        companyId: globex._id,
        managerId: mikeRoss._id,
        assignedGatewayIds: [gw4._id],
        assignedTagIds: [t6._id, t7._id],
        active: true
      })
      const dianaPrince = await User.create({
        name: 'Diana Prince',
        email: 'diana@globex.com',
        passwordHash,
        role: 'employee',
        companyId: globex._id,
        managerId: mikeRoss._id,
        assignedGatewayIds: [gw4._id, gw5._id],
        assignedTagIds: [t6._id, t7._id, t8._id, t9._id],
        active: true
      })
      const peterParker = await User.create({
        name: 'Peter Parker',
        email: 'peter@initech.com',
        passwordHash,
        role: 'employee',
        companyId: initech._id,
        managerId: lisaChen._id,
        assignedGatewayIds: [gw6._id],
        assignedTagIds: [t10._id],
        active: true
      })

      await TelemetryTag.findByIdAndUpdate(t1._id, { $addToSet: { assignedEmployeeIds: [janeEmployee._id, bobSmith._id] } })
      await TelemetryTag.findByIdAndUpdate(t2._id, { $addToSet: { assignedEmployeeIds: [janeEmployee._id, bobSmith._id] } })
      await TelemetryTag.findByIdAndUpdate(t3._id, { $addToSet: { assignedEmployeeIds: [janeEmployee._id, aliceWong._id] } })
      await TelemetryTag.findByIdAndUpdate(t4._id, { $addToSet: { assignedEmployeeIds: [janeEmployee._id, aliceWong._id] } })
      await TelemetryTag.findByIdAndUpdate(t5._id, { $addToSet: { assignedEmployeeIds: [aliceWong._id] } })
      await TelemetryTag.findByIdAndUpdate(t6._id, { $addToSet: { assignedEmployeeIds: [tomHardy._id, dianaPrince._id] } })
      await TelemetryTag.findByIdAndUpdate(t7._id, { $addToSet: { assignedEmployeeIds: [tomHardy._id, dianaPrince._id] } })
      await TelemetryTag.findByIdAndUpdate(t8._id, { $addToSet: { assignedEmployeeIds: [dianaPrince._id] } })
      await TelemetryTag.findByIdAndUpdate(t9._id, { $addToSet: { assignedEmployeeIds: [dianaPrince._id] } })
      await TelemetryTag.findByIdAndUpdate(t10._id, { $addToSet: { assignedEmployeeIds: [peterParker._id] } })

      console.log('Seeding historical telemetry readings...')
      const now = Date.now()
      const allTags = [t1, t2, t3, t4, t5, t6, t7, t8, t9, t10]
      for (const tag of allTags) {
        const baseValue = Math.random() * 50 + 20
        for (let i = 0; i < 20; i++) {
          await TelemetryReading.create({
            companyId: tag.companyId,
            gatewayId: tag.gatewayId,
            tagId: tag._id,
            telemetryTopic: tag.telemetryTopic,
            value: +(baseValue + Math.random() * 10 - 5).toFixed(2),
            arrivedAt: new Date(now - i * 5 * 60 * 1000)
          })
        }
      }
      console.log('Telemetry readings seeded successfully.')
    } else {
      console.log('Seeding MINIMUM core data (SEED_DEMO_DATA=false)...')
      const defaultCompany = await Company.create({
        name: 'Default Company',
        slug: 'default-company',
        description: 'Standard company space'
      })

      const admin = await User.create({
        name: 'Admin User',
        email: 'admin@gmail.com',
        passwordHash,
        role: 'admin',
        active: true
      })

      const defaultManager = await User.create({
        name: 'Default Manager',
        email: 'manager@gmail.com',
        passwordHash,
        role: 'manager',
        companyId: defaultCompany._id,
        active: true
      })

      const defaultEmployee = await User.create({
        name: 'Default Employee',
        email: 'employee@gmail.com',
        passwordHash,
        role: 'employee',
        companyId: defaultCompany._id,
        managerId: defaultManager._id,
        active: true
      })

      console.log('Admin, Manager, and Employee core accounts created.')
    }

    console.log('Database seeded successfully!')
    process.exit(0)
  } catch (error) {
    console.error('Seeding error:', error.message)
    process.exit(1)
  }
}

seed()
