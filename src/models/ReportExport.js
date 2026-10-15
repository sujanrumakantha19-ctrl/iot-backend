const mongoose = require('mongoose')

const reportExportSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filters: { type: Object, default: {} },
  format: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
})

reportExportSchema.index({ companyId: 1, createdAt: -1 })
reportExportSchema.index({ generatedBy: 1 })

module.exports = mongoose.model('ReportExport', reportExportSchema)
