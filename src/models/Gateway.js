const mongoose = require('mongoose')

const wifiStatusSchema = new mongoose.Schema({
  ssid: { type: String, default: '' },
  rssi: { type: String, default: '' },
  ipAddress: { type: String, default: '' },
  delay: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
}, { _id: false })

const deviceMappingSchema = new mongoose.Schema({
  slaveId: { type: Number, required: true },
  deviceName: { type: String, required: true },
  baudRate: { type: Number, default: 115200 },
  serialConfig: { type: String, default: '8N1' }
}, { _id: false })

const gatewaySchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true },
  prefix: { type: String, required: true, unique: true },
  location: { type: String, default: '' },
  maxParameters: { type: Number, default: 1000, min: 1, max: 5000 },
  maxGroups: { type: Number, default: 20, min: 1, max: 100 },
  publishInterval: { type: Number, default: 5 },
  status: { type: String, required: true, enum: ['online', 'offline'], default: 'offline' },
  version: { type: String, default: 'Unknown' },
  lastSeenAt: { type: Date, default: Date.now },
  lastWifiStatus: { type: wifiStatusSchema, default: null },
  lastConfigPayload: {
    payload: { type: String, default: '' },
    updatedAt: { type: Date, default: null }
  },
  devices: {
    type: [deviceMappingSchema],
    default: [{ slaveId: 1, deviceName: 'Device1', baudRate: 115200, serialConfig: '8N1' }]
  },
  gps: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    updatedAt: { type: Date, default: null }
  }
}, {
  timestamps: true
})

// Indexes
gatewaySchema.index({ companyId: 1, name: 1 })

module.exports = mongoose.model('Gateway', gatewaySchema)
