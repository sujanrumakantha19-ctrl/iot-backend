const ActivityLog = require('../models/ActivityLog')

/**
 * Log a user or system activity asynchronously.
 * Designed to never fail or throw unhandled exceptions to calling routes.
 */
async function logActivity({
  user,
  userId,
  userName,
  userEmail,
  userPhone,
  userRole,
  companyId,
  companyName,
  action,
  category = 'System',
  details = '',
  metadata = {},
  req
}) {
  try {
    const effectiveUserId = userId || user?._id || user?.id
    const effectiveUserName = userName || user?.name || 'System User'
    const effectiveUserEmail = userEmail || user?.email || ''
    const effectiveUserPhone = userPhone || user?.phone || user?.phoneNumber || ''
    const effectiveUserRole = userRole || user?.role || 'admin'

    let effectiveCompanyId = companyId || user?.companyId?._id || user?.companyId
    let effectiveCompanyName = companyName || user?.companyId?.name || ''

    let ipAddress = ''
    if (req) {
      ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || ''
    }

    await ActivityLog.create({
      userId: effectiveUserId || null,
      userName: effectiveUserName,
      userEmail: effectiveUserEmail,
      userPhone: effectiveUserPhone,
      userRole: effectiveUserRole,
      companyId: effectiveCompanyId || null,
      companyName: effectiveCompanyName || 'System',
      action: action || 'GENERAL_ACTION',
      category: category || 'System',
      details: details || '',
      metadata: metadata || {},
      ipAddress: typeof ipAddress === 'string' ? ipAddress.split(',')[0].trim() : '',
      timestamp: new Date()
    })
  } catch (err) {
    console.error('[ActivityLogger] Error logging activity:', err.message)
  }
}

module.exports = { logActivity }
