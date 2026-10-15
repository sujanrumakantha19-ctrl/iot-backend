const mongoose = require('mongoose')

const quickInsightBarSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tagId: { type: mongoose.Schema.Types.ObjectId, ref: 'TelemetryTag', required: true },
  color: { type: String, default: '#22c55e' },
  minValue: { type: Number, default: -140 },
  maxValue: { type: Number, default: 140 },
  idleValue: { type: Number, default: 0 },
  order: { type: Number, default: 0 }
}, {
  timestamps: true
})

quickInsightBarSchema.index({ companyId: 1, managerId: 1 })
quickInsightBarSchema.index({ companyId: 1, tagId: 1 })

module.exports = mongoose.model('QuickInsightBar', quickInsightBarSchema)
