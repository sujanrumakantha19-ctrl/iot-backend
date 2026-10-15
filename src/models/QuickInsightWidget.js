const mongoose = require('mongoose')

const quickInsightWidgetSchema = new mongoose.Schema({
  tabId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuickInsightTab', required: true },
  tagId: { type: mongoose.Schema.Types.ObjectId, ref: 'TelemetryTag', default: null },
  assetTwinInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssetTwinInstance', default: null },
  type: { type: String, enum: ['meter', 'graph', 'assetTwin'], required: true },
  visualizationId: { type: String, default: null },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  w: { type: Number, default: 3 },
  h: { type: Number, default: 2 },
  meterMin: { type: Number, default: null },
  meterMax: { type: Number, default: null },
  meterIdle: { type: Number, default: 0 },
  meterColor: { type: String, default: '#22c55e' }
}, {
  timestamps: true
})

quickInsightWidgetSchema.index({ tabId: 1 })
quickInsightWidgetSchema.index({ assetTwinInstanceId: 1 })

module.exports = mongoose.model('QuickInsightWidget', quickInsightWidgetSchema)
