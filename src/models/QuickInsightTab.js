const mongoose = require('mongoose')

const quickInsightTabSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true },
  order: { type: Number, default: 0 }
}, {
  timestamps: true
})

quickInsightTabSchema.index({ companyId: 1, managerId: 1, employeeId: 1 })
quickInsightTabSchema.index({ employeeId: 1 })

module.exports = mongoose.model('QuickInsightTab', quickInsightTabSchema)
