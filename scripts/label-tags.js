require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const mongoose = require('mongoose')
const TelemetryTag = require('../src/models/TelemetryTag')

const sensors = [
  'Temperature', 'Humidity', 'Pressure', 'Flow Rate', 'Level',
  'pH', 'Conductivity', 'Vibration', 'Current', 'Voltage',
  'Power', 'Frequency', 'Speed', 'Torque', 'Position',
  'Acceleration', 'Strain', 'Force', 'Displacement', 'Velocity'
]

const devices = [
  'Sensor-A', 'Sensor-B', 'Sensor-C', 'Sensor-D', 'Sensor-E',
  'Transmitter-1', 'Transmitter-2', 'Transmitter-3',
  'Probe-1', 'Probe-2', 'Probe-3', 'Probe-4',
  'Meter-1', 'Meter-2', 'Meter-3',
  'Module-X1', 'Module-X2', 'Module-X3',
  'Unit-ALPHA', 'Unit-BETA', 'Unit-GAMMA', 'Unit-DELTA',
  'Node-01', 'Node-02', 'Node-03', 'Node-04', 'Node-05'
]

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('Connected to MongoDB')

  const tags = await TelemetryTag.find({}).lean()
  console.log(`Found ${tags.length} tags to label`)

  let updated = 0
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]
    const idx = i % sensors.length
    const devIdx = Math.floor(i / sensors.length) % devices.length
    const group = Math.floor(i / (sensors.length * devices.length)) + 1

    const sensor = sensors[idx]
    const device = devices[devIdx]
    const topicName = `${sensor.replace(/\s+/g, '_')}_${device.replace(/[^a-zA-Z0-9]/g, '_')}`
    const telemetryTopic = tag.telemetryTopic && tag.telemetryTopic.includes('/')
      ? tag.telemetryTopic
      : `company/${device.toLowerCase()}/${topicName.toLowerCase()}`

    await TelemetryTag.updateOne(
      { _id: tag._id },
      {
        $set: {
          topicName,
          parameterName: sensor,
          deviceName: device,
          displayName: `${device} - ${sensor}`,
          unit: getUnit(sensor),
          telemetryTopic: telemetryTopic
        }
      }
    )
    updated++
  }

  console.log(`Labeled ${updated} tags`)
  await mongoose.disconnect()
}

function getUnit(sensor) {
  const units = {
    'Temperature': '°C',
    'Humidity': '%',
    'Pressure': 'bar',
    'Flow Rate': 'L/min',
    'Level': 'm',
    'pH': '',
    'Conductivity': 'µS/cm',
    'Vibration': 'mm/s',
    'Current': 'A',
    'Voltage': 'V',
    'Power': 'kW',
    'Frequency': 'Hz',
    'Speed': 'RPM',
    'Torque': 'Nm',
    'Position': 'mm',
    'Acceleration': 'm/s²',
    'Strain': 'µm/m',
    'Force': 'N',
    'Displacement': 'mm',
    'Velocity': 'm/s'
  }
  return units[sensor] || ''
}

run().catch(err => { console.error(err); process.exit(1) })
