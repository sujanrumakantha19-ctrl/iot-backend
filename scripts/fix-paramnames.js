require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const mongoose = require('mongoose')
const TelemetryTag = require('../src/models/TelemetryTag')

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI)
  const tags = await TelemetryTag.find({}, 'parameterName topicName').sort({ _id: 1 }).lean()
  console.log(`Found ${tags.length} tags`)

  let updated = 0
  for (let i = 0; i < tags.length; i++) {
    const newName = `p${i + 1}`
    if (tags[i].parameterName !== newName) {
      await TelemetryTag.updateOne({ _id: tags[i]._id }, { $set: { parameterName: newName } })
      updated++
    }
  }
  console.log(`Updated ${updated} parameterNames (p1..p${tags.length})`)
  await mongoose.disconnect()
}
run().catch(e => { console.error(e); process.exit(1) })
