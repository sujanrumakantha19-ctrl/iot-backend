const mongoose = require('mongoose')

const tagBindingsSchema = new mongoose.Schema({
  deVib: { type: mongoose.Schema.Types.ObjectId, ref: 'TelemetryTag', default: null },
  deTemp: { type: mongoose.Schema.Types.ObjectId, ref: 'TelemetryTag', default: null },
  ndeVib: { type: mongoose.Schema.Types.ObjectId, ref: 'TelemetryTag', default: null },
  ndeTemp: { type: mongoose.Schema.Types.ObjectId, ref: 'TelemetryTag', default: null },
  rpm: { type: mongoose.Schema.Types.ObjectId, ref: 'TelemetryTag', default: null },
  current: { type: mongoose.Schema.Types.ObjectId, ref: 'TelemetryTag', default: null }
}, { _id: false })

const assetTwinInstanceSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true, trim: true },
  templateId: { type: String, required: true },
  gatewayId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gateway', default: null },
  description: { type: String, default: '' },
  tagBindings: { type: tagBindingsSchema, default: () => ({}) },
  assignedEmployeeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  active: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, {
  timestamps: true
})

assetTwinInstanceSchema.index({ companyId: 1, name: 1 })
assetTwinInstanceSchema.index({ companyId: 1, createdAt: -1 })
assetTwinInstanceSchema.index({ assignedEmployeeIds: 1 })

module.exports = mongoose.model('AssetTwinInstance', assetTwinInstanceSchema)
