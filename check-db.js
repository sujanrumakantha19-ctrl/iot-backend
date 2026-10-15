const mongoose = require('mongoose')
require('dotenv').config()

const User = require('./src/models/User')
const TelemetryTag = require('./src/models/TelemetryTag')

async function run() {
  await mongoose.connect('mongodb://localhost:27017/IOTNEW')
  console.log('--- USERS IN DB (IOTNEW) ---')
  const users = await User.find({}, '_id name email role companyId managerId active').lean()
  console.log(JSON.stringify(users, null, 2))

  console.log('\n--- TAGS WITH ASSIGNED EMPLOYEES (IOTNEW) ---')
  const tags = await TelemetryTag.find({ assignedEmployeeIds: { $exists: true, $ne: [] } }, '_id parameterName displayName assignedEmployeeIds companyId').lean()
  console.log(JSON.stringify(tags, null, 2))

  await mongoose.disconnect()
}

run().catch(console.error)
