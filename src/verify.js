require('dotenv').config()
const mongoose = require('mongoose')
const Company = require('./models/Company')
const User = require('./models/User')
const Gateway = require('./models/Gateway')
const TelemetryTag = require('./models/TelemetryTag')
const TelemetryReading = require('./models/TelemetryReading')

const runVerify = async () => {
  try {
    console.log('Connecting to MongoDB at:', process.env.MONGODB_URI)
    await mongoose.connect(process.env.MONGODB_URI)
    console.log('Connected successfully.')

    const companyCount = await Company.countDocuments()
    const userCount = await User.countDocuments()
    const gatewayCount = await Gateway.countDocuments()
    const tagCount = await TelemetryTag.countDocuments()
    const readingCount = await TelemetryReading.countDocuments()

    console.log('\n--- Seeding Statistics Verification ---')
    console.log('Companies count:', companyCount)
    console.log('Users count (Admin, Managers, Employees):', userCount)
    console.log('Gateways count:', gatewayCount)
    console.log('Telemetry Tags count:', tagCount)
    console.log('Telemetry Readings count:', readingCount)
    console.log('---------------------------------------\n')

    if (companyCount === 3 && userCount === 11 && gatewayCount === 6 && tagCount === 10) {
      console.log('SUCCESS: All seed database records count match exactly!')
    } else {
      console.warn('WARNING: Seed database counts differ from default template!')
    }

    // Verify authentication credentials exist
    const admin = await User.findOne({ email: 'admin@gmail.com' })
    const manager = await User.findOne({ email: 'manager@gmail.com' })
    const employee = await User.findOne({ email: 'employee@gmail.com' })

    console.log('\nChecking default login accounts:')
    console.log('Admin user exists:', !!admin, admin ? `(Role: ${admin.role})` : '')
    console.log('Manager user exists:', !!manager, manager ? `(Role: ${manager.role})` : '')
    console.log('Employee user exists:', !!employee, employee ? `(Role: ${employee.role})` : '')

    if (admin && manager && employee) {
      console.log('\nSUCCESS: All default authentication credentials are valid and present.')
      process.exit(0)
    } else {
      console.error('\nFAILURE: Missing default login credentials.')
      process.exit(1)
    }
  } catch (error) {
    console.error('Verification failed with error:', error.message)
    process.exit(1)
  }
}

runVerify()
