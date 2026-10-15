const mongoose = require('mongoose')

const modbusRowSchema = new mongoose.Schema({
  deviceName: { type: String, required: true },
  slaveId: { type: Number, required: true },
  parameterName: { type: String, required: true },
  functionCode: { type: Number, required: true },
  address: { type: Number, required: true },
  length: { type: Number, required: true },
  dataType: { type: String, required: true },
  scaleFactor: { type: Number, required: true },
  decimal: { type: mongoose.Schema.Types.Mixed, default: 'None' },
  baudRate: { type: Number, required: true },
  serialConfig: { type: String, required: true },
  unit: { type: String, default: '' },
  topicName: { type: String, default: '' }
}, { _id: false })

const groupSchema = new mongoose.Schema({
  groupNum: { type: Number, required: true },   // stable group number — never changes on delete
  rows: [modbusRowSchema],
  publishStatus: {
    type: String,
    enum: ['pending', 'success', 'failed'],
    default: 'pending'
  },
  publishedAt: { type: Date, default: null }
}, { _id: false })

const pendingBoardDeleteSchema = new mongoose.Schema({
  groupNum: { type: Number, required: true },
  deletedAt: { type: Date, default: Date.now }
}, { _id: false })

const gatewayConfigSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  gatewayId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gateway', required: true },
  version: { type: Number, default: 1 },
  rows: [modbusRowSchema],
  groups: [groupSchema],
  payload: { type: String, required: true },
  publishStatus: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  publishedAt: { type: Date, default: null },
  publishError: { type: String, default: null },
  groupCount: { type: Number, default: 1 },
  pendingBoardDeletes: [pendingBoardDeleteSchema],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, {
  timestamps: true
})

// Indexes
gatewayConfigSchema.index({ gatewayId: 1, createdAt: -1 })
gatewayConfigSchema.index({ companyId: 1, createdAt: -1 })

module.exports = mongoose.model('GatewayConfig', gatewayConfigSchema)
