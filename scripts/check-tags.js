require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const mongoose = require('mongoose')
const Gateway = require('../src/models/Gateway')
const TelemetryTag = require('../src/models/TelemetryTag')

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI)
  const gwCount = await Gateway.countDocuments()
  const gw = await Gateway.findOne({ prefix: 'SG' }).lean()
  if (!gw) {
    console.log('No gateway with prefix SG found')
    const allGws = await Gateway.find({}, 'prefix name').lean()
    console.log('Available gateways:', allGws.map(g => g.prefix).join(', '))
    process.exit()
  }
  console.log('Gateway:', gw.prefix, gw.name)
  const tagCount = await TelemetryTag.countDocuments({ gatewayId: gw._id })
  console.log('Tags for this gateway:', tagCount)
  const sample = await TelemetryTag.find({ gatewayId: gw._id }, 'parameterName topicName deviceName').limit(10).lean()
  sample.forEach(t => console.log('  ->', t.parameterName))
  await mongoose.disconnect()
}
run().catch(e => { console.error(e); process.exit(1) })
