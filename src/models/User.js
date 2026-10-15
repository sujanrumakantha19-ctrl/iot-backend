const mongoose = require('mongoose')

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  role: { type: String, required: true, enum: ['admin', 'manager', 'employee'] },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },
  managerId: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  assignedGatewayIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Gateway' }],
  assignedTagIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TelemetryTag' }],
  active: { type: Boolean, default: true },
  addressLabel: { type: String, default: '' },
  address: { type: String, default: '' },
  themePreference: { type: String, default: 'default' },
  profilePhoto: { type: String, default: '' },
  assignPermissionMode: { type: String, enum: ['all', 'limit', 'restrict'], default: 'all' },
  allowedGraphIds: [{ type: String }],
  allowedMeterTypes: [{ type: String }],
  featurePermissions: {
    showUsers: { type: Boolean, default: true },
    showGateway: { type: Boolean, default: false },
    gatewayFeatures: {
      showDeviceList: { type: Boolean, default: false },
      showPublish: { type: Boolean, default: false },
      showReadConfig: { type: Boolean, default: false },
      showWifi: { type: Boolean, default: false },
      showLocation: { type: Boolean, default: false },
      showPublishInterval: { type: Boolean, default: false }
    }
  }
}, {
  timestamps: true
})

// Indexes
userSchema.index({ role: 1, companyId: 1 })
userSchema.index({ managerId: 1 })

module.exports = mongoose.model('User', userSchema)
