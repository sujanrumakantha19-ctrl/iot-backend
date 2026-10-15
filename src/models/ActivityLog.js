const mongoose = require('mongoose')

const activityLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
  userName: { type: String, default: 'System / User' },
  userEmail: { type: String, default: '' },
  userPhone: { type: String, default: '' },
  userRole: { type: String, enum: ['admin', 'manager', 'employee', 'system'], default: 'admin' },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: false },
  companyName: { type: String, default: 'System' },
  action: { type: String, required: true },
  category: { type: String, enum: ['Security', 'Gateway', 'Company', 'User', 'Telemetry', 'System'], default: 'System' },
  details: { type: String, default: '' },
  metadata: { type: Object, default: {} },
  ipAddress: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now }
})

// Performance Indexes
activityLogSchema.index({ timestamp: -1 })
activityLogSchema.index({ userEmail: 1, timestamp: -1 })
activityLogSchema.index({ userPhone: 1, timestamp: -1 })
activityLogSchema.index({ companyId: 1, timestamp: -1 })
activityLogSchema.index({ userId: 1, timestamp: -1 })
activityLogSchema.index({ category: 1, timestamp: -1 })

module.exports = mongoose.model('ActivityLog', activityLogSchema)
