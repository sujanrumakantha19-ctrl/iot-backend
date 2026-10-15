const User = require('../models/User')
const Gateway = require('../models/Gateway')
const TelemetryTag = require('../models/TelemetryTag')
const TelemetryReading = require('../models/TelemetryReading')
const GatewayConfig = require('../models/GatewayConfig')
const cache = require('./cache')

/**
 * Full Cascade Cleanup for Gateway Deletion
 */
async function cleanupGatewayCascade(gatewayId, appLocals = {}) {
  const gateway = await Gateway.findById(gatewayId)
  if (!gateway) return null

  const companyId = gateway.companyId

  // 1. Fetch all TelemetryTags for this gateway
  const tags = await TelemetryTag.find({ gatewayId: gateway._id }).select('_id').lean()
  const tagIds = tags.map(t => t._id)

  // 2. Pull tag IDs and gateway ID from all User documents
  const affectedUsers = await User.find({
    $or: [
      { assignedTagIds: { $in: tagIds } },
      { assignedGatewayIds: gateway._id }
    ]
  }).select('_id assignedTagIds assignedGatewayIds').lean()

  if (tagIds.length > 0) {
    await User.updateMany(
      {},
      {
        $pull: {
          assignedTagIds: { $in: tagIds },
          assignedGatewayIds: gateway._id
        }
      }
    )
  } else {
    await User.updateMany(
      {},
      { $pull: { assignedGatewayIds: gateway._id } }
    )
  }

  // 3. Delete related TelemetryTags, TelemetryReadings, GatewayConfigs, QuickInsightWidgets
  const QuickInsightWidget = require('../models/QuickInsightWidget')
  await Promise.all([
    TelemetryTag.deleteMany({ gatewayId: gateway._id }),
    TelemetryReading.deleteMany({ gatewayId: gateway._id }),
    GatewayConfig.deleteMany({ gatewayId: gateway._id }),
    tagIds.length > 0 ? QuickInsightWidget.deleteMany({ tagId: { $in: tagIds } }) : Promise.resolve()
  ])

  // 4. Delete Gateway document
  await Gateway.deleteOne({ _id: gateway._id })

  // 5. Unsubscribe MQTT topics if broker available
  if (appLocals.mqttClient && typeof appLocals.mqttClient.unsubscribeFromGatewayTopics === 'function') {
    try {
      appLocals.mqttClient.unsubscribeFromGatewayTopics(gateway.prefix)
    } catch (mqttErr) {
      console.error(`[GatewayCleanup] Failed to unsubscribe MQTT topics for ${gateway.prefix}:`, mqttErr.message)
    }
  }

  // 6. Flush cache
  cache.flush()

  // 7. Emit Socket.IO refresh events
  const io = appLocals.io
  if (io) {
    io.to('admins').emit('gateway:deleted', { gatewayId: gateway._id.toString(), companyId: companyId?.toString() })
    if (companyId) {
      io.to(`company:${companyId}`).emit('gateway:deleted', { gatewayId: gateway._id.toString(), companyId: companyId.toString() })
      io.to(`company:${companyId}`).emit('dashboard:refresh-required', { gatewayId: gateway._id.toString() })
    }
    affectedUsers.forEach(u => {
      const uIdStr = u._id.toString()
      io.to(`employee:${uIdStr}`).emit('telemetry:assignments-updated', { gatewayId: gateway._id.toString() })
      io.to(`user:${uIdStr}`).emit('telemetry:assignments-updated', { gatewayId: gateway._id.toString() })
    })
  }

  return gateway
}

/**
 * Group-Level Cleanup when a Modbus Group is deleted
 */
async function cleanupGroupCascade(gatewayId, deletedGroupRows = [], appLocals = {}) {
  const gateway = await Gateway.findById(gatewayId)
  if (!gateway) return { tagIds: [], affectedUserIds: [] }

  const companyId = gateway.companyId
  if (!deletedGroupRows || deletedGroupRows.length === 0) {
    return { tagIds: [], affectedUserIds: [] }
  }

  // 1. Derive parameter and topic names from deleted rows
  const parameterNames = deletedGroupRows.map(r => r.parameterName ? r.parameterName.replace(/^[tp](\d+)$/i, 'P$1') : '').filter(Boolean)
  const topicNames = deletedGroupRows.map(r => r.topicName ? r.topicName.replace(/^[tp](\d+)$/i, 'P$1') : '').filter(Boolean)
  const allIdentifiers = [...new Set([...parameterNames, ...topicNames])]

  // 2. Find matching TelemetryTags for this gateway
  const matchingTags = await TelemetryTag.find({
    gatewayId: gateway._id,
    $or: [
      { parameterName: { $in: allIdentifiers } },
      { topicName: { $in: allIdentifiers } }
    ]
  }).select('_id parameterName topicName').lean()

  const deletedTagIds = matchingTags.map(t => t._id)
  if (deletedTagIds.length === 0) {
    return { tagIds: [], affectedUserIds: [] }
  }

  // 3. Find all users assigned any of these deleted tags
  const affectedUsers = await User.find({ assignedTagIds: { $in: deletedTagIds } }).select('_id assignedTagIds companyId').lean()
  const affectedUserIds = affectedUsers.map(u => u._id)

  // 4. Pull deleted tag IDs from all users
  await User.updateMany(
    { assignedTagIds: { $in: deletedTagIds } },
    { $pull: { assignedTagIds: { $in: deletedTagIds } } }
  )

  // 5. Delete TelemetryTags, TelemetryReadings, and QuickInsightWidgets for those deleted tag IDs
  const QuickInsightWidget = require('../models/QuickInsightWidget')
  await Promise.all([
    TelemetryTag.deleteMany({ _id: { $in: deletedTagIds } }),
    TelemetryReading.deleteMany({ tagId: { $in: deletedTagIds } }),
    QuickInsightWidget.deleteMany({ tagId: { $in: deletedTagIds } })
  ])

  // 6. Recalculate assignedGatewayIds for affected users
  for (const user of affectedUsers) {
    const freshUser = await User.findById(user._id).select('assignedTagIds').lean()
    const remainingTagIds = freshUser.assignedTagIds || []
    if (remainingTagIds.length > 0) {
      const remainingTags = await TelemetryTag.find({ _id: { $in: remainingTagIds } }).select('gatewayId').lean()
      const newGwIds = [...new Set(remainingTags.map(t => t.gatewayId?.toString()).filter(Boolean))]
      await User.findByIdAndUpdate(user._id, { assignedGatewayIds: newGwIds })
    } else {
      await User.findByIdAndUpdate(user._id, { assignedGatewayIds: [] })
    }
  }

  // 7. Flush cache
  cache.flush()

  // 8. Socket.IO notification
  const io = appLocals.io
  if (io) {
    io.to('admins').emit('gateway:group-deleted', { gatewayId: gateway._id.toString(), tagIds: deletedTagIds.map(t => t.toString()) })
    if (companyId) {
      io.to(`company:${companyId}`).emit('gateway:group-deleted', { gatewayId: gateway._id.toString(), tagIds: deletedTagIds.map(t => t.toString()) })
      io.to(`company:${companyId}`).emit('dashboard:refresh-required', {})
    }
    affectedUserIds.forEach(uId => {
      const uIdStr = uId.toString()
      io.to(`employee:${uIdStr}`).emit('telemetry:assignments-updated', { gatewayId: gateway._id.toString() })
      io.to(`user:${uIdStr}`).emit('telemetry:assignments-updated', { gatewayId: gateway._id.toString() })
    })
  }

  return { tagIds: deletedTagIds, affectedUserIds }
}

module.exports = {
  cleanupGatewayCascade,
  cleanupGroupCascade,
  // Re-export shared tag sync helpers used by publish/admin flows
  reconcileGatewayTags: require('./tagSync').reconcileGatewayTags,
  resolveExistingAssignedTagIds: require('./tagSync').resolveExistingAssignedTagIds
}
