const mongoose = require('mongoose')

const companyAssetTwinAccessSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  templateId: { type: String, required: true },
  enabled: { type: Boolean, default: true },
  enabledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, {
  timestamps: true
})

companyAssetTwinAccessSchema.index({ companyId: 1, templateId: 1 }, { unique: true })

module.exports = mongoose.model('CompanyAssetTwinAccess', companyAssetTwinAccessSchema)
