const mongoose = require('mongoose')

const telemetryTagSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  gatewayId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gateway', required: true },
  topicName: { type: String, required: true },
  telemetryTopic: { type: String, required: true, unique: true },
  parameterName: { type: String, required: true },
  displayName: { type: String, default: '' },
  deviceName: { type: String, required: true },
  address: { type: Number, default: null },
  unit: { type: String, default: '' },
  scaleFactor: { type: Number, default: 1 },
  decimal: { type: mongoose.Schema.Types.Mixed, default: 'None' },
  assignedEmployeeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  watchlistedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  latestValue: { type: Number, default: null },
  latestValueStr: { type: String, default: null },
  latestArrivedAt: { type: Date, default: null },
  todayMax: { type: Number, default: null },
  yesterdayMax: { type: Number, default: null },
  weekMax: { type: Number, default: null },
  dashboardUpdatedAt: { type: Date, default: null },
  warningThreshold: { type: Number, default: null },
  criticalThreshold: { type: Number, default: null },
  alertsEnabled: { type: Boolean, default: true },
  lastWarningAlertSentAt: { type: Date, default: null },
  lastCriticalAlertSentAt: { type: Date, default: null },
  lastAlertState: { type: String, enum: ['normal', 'warning', 'critical'], default: 'normal' },
  assignedGraphType: { type: String, default: null },
  assignedMeterType: { type: String, default: null },
  meterMin: { type: Number, default: null },
  meterMax: { type: Number, default: null },
  meterIdle: { type: Number, default: 0 },
  meterColor: { type: String, default: '#22c55e' }
}, {
  timestamps: true
})

// Indexes
telemetryTagSchema.index({ companyId: 1, gatewayId: 1 })
telemetryTagSchema.index({ gatewayId: 1 })
telemetryTagSchema.index({ companyId: 1 })
telemetryTagSchema.index({ assignedEmployeeIds: 1 })

module.exports = mongoose.model('TelemetryTag', telemetryTagSchema)
