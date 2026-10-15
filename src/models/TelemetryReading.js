const mongoose = require('mongoose')

const telemetryReadingSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  gatewayId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gateway', required: true },
  tagId: { type: mongoose.Schema.Types.ObjectId, ref: 'TelemetryTag', required: true },
  telemetryTopic: { type: String, required: true },
  value: { type: Number, required: true },
  valueStr: { type: String, default: null },
  arrivedAt: { type: Date, default: Date.now }
})

// Indexes
telemetryReadingSchema.index({ tagId: 1, arrivedAt: -1 })
telemetryReadingSchema.index({ companyId: 1, arrivedAt: -1 })
telemetryReadingSchema.index({ telemetryTopic: 1, arrivedAt: -1 })
telemetryReadingSchema.index({ tagId: 1, arrivedAt: -1, value: 1 })

module.exports = mongoose.model('TelemetryReading', telemetryReadingSchema)
