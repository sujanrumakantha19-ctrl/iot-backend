const mongoose = require('mongoose')
const User = require('../models/User')
const TelemetryTag = require('../models/TelemetryTag')
const TelemetryReading = require('../models/TelemetryReading')
const GatewayConfig = require('../models/GatewayConfig')
const cache = require('./cache')

function normalizeIdentifier(name) {
  if (!name) return ''
  return String(name).replace(/^[tp](\d+)$/i, 'P$1').toUpperCase()
}

function activeIdentifiersFromRows(rows = []) {
  const set = new Set()
  for (const r of rows) {
    const pName = normalizeIdentifier(r.parameterName)
    const tName = normalizeIdentifier(r.topicName) || pName
    if (pName) set.add(pName)
    if (tName) set.add(tName)
  }
  return set
}

/**
 * Resolve assignedTagIds to IDs that still exist in TelemetryTag.
 * Optionally prune dead IDs from the user document.
 */
async function resolveExistingAssignedTagIds(assignedTagIds = [], { pruneUserId = null } = {}) {
  const rawIds = (assignedTagIds || [])
    .map(id => (id?._id || id)?.toString?.() || String(id))
    .filter(id => mongoose.Types.ObjectId.isValid(id))

  if (rawIds.length === 0) {
    if (pruneUserId) {
      const user = await User.findById(pruneUserId).select('assignedTagIds assignedGatewayIds').lean()
      if (user && (user.assignedTagIds || []).length > 0) {
        await User.findByIdAndUpdate(pruneUserId, { assignedTagIds: [], assignedGatewayIds: [] })
        cache.invalidate?.(`emp_dash:${pruneUserId}`)
      }
    }
    return []
  }

  const existing = await TelemetryTag.find({ _id: { $in: rawIds } }).select('_id gatewayId').lean()
  const existingIds = existing.map(t => t._id.toString())
  const existingSet = new Set(existingIds)

  if (pruneUserId && existingIds.length !== rawIds.length) {
    const uniqueGwIds = [...new Set(existing.map(t => t.gatewayId?.toString()).filter(Boolean))]
    await User.findByIdAndUpdate(pruneUserId, {
      assignedTagIds: existingIds,
      assignedGatewayIds: uniqueGwIds
    })
    cache.invalidate?.(`emp_dash:${pruneUserId}`)
    if (existing[0]?.gatewayId) {
      // company cache best-effort; caller can flush more broadly
    }
  }

  return existingIds
}

/**
 * Count only existing assigned tags for a list of users (batch).
 * Returns Map<userIdString, count>
 */
async function countExistingAssignedTags(employees = []) {
  const allIds = []
  const perUser = employees.map(emp => {
    const ids = (emp.assignedTagIds || [])
      .map(id => {
        if (!id) return null
        if (typeof id === 'object' && id._id) return id._id.toString()
        const str = id.toString?.() || String(id)
        return mongoose.Types.ObjectId.isValid(str) ? str : null
      })
      .filter(Boolean)
    allIds.push(...ids)
    return { userId: emp._id.toString(), ids }
  })

  const uniqueIds = [...new Set(allIds)]
  let existingSet = new Set()
  if (uniqueIds.length > 0) {
    const existing = await TelemetryTag.find({ _id: { $in: uniqueIds } }).select('_id').lean()
    existingSet = new Set(existing.map(t => t._id.toString()))
  }

  const counts = new Map()
  for (const row of perUser) {
    counts.set(row.userId, row.ids.filter(id => existingSet.has(id)).length)
  }
  return counts
}

/**
 * After gateway company change: clear tag employee assignments and pull
 * those tags from any users' assignedTagIds.
 */
async function clearTagAssignmentsForGateway(gatewayId) {
  const tags = await TelemetryTag.find({ gatewayId }).select('_id').lean()
  const tagIds = tags.map(t => t._id)
  if (tagIds.length === 0) return

  await TelemetryTag.updateMany(
    { gatewayId },
    { $set: { assignedEmployeeIds: [] } }
  )

  await User.updateMany(
    { assignedTagIds: { $in: tagIds } },
    { $pull: { assignedTagIds: { $in: tagIds } } }
  )

  // Recalc assignedGatewayIds for affected users is expensive; pull gateway id too
  await User.updateMany(
    { assignedGatewayIds: gatewayId },
    { $pull: { assignedGatewayIds: gatewayId } }
  )

  cache.flush()
}

/**
 * Reconcile TelemetryTags for a gateway against latest GatewayConfig:
 * - delete orphan tags not in active config rows
 * - dedupe by telemetryTopic (keep newest)
 * - prune user assignments for deleted tags
 */
async function reconcileGatewayTags(gatewayId, appLocals = {}) {
  const gwId = gatewayId
  const latestConfig = await GatewayConfig.findOne({ gatewayId: gwId })
    .sort({ createdAt: -1 })
    .select('rows groups')
    .lean()

  const rows = latestConfig?.rows?.length
    ? latestConfig.rows
    : (latestConfig?.groups || []).flatMap(g => g.rows || [])

  // If no config, do not wipe all tags (gateway may be mid-setup)
  if (!latestConfig) {
    return { orphanTagIds: [], duplicateTagIds: [], affectedUserIds: [] }
  }

  const activeIds = activeIdentifiersFromRows(rows)

  const existingTags = await TelemetryTag.find({ gatewayId: gwId })
    .select('_id parameterName topicName telemetryTopic deviceName createdAt updatedAt')
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean()

  const orphanTags = existingTags.filter(t => {
    const pNorm = normalizeIdentifier(t.parameterName)
    const tNorm = normalizeIdentifier(t.topicName)
    // Also treat as active if either identifier matches
    const inActive = (pNorm && activeIds.has(pNorm)) || (tNorm && activeIds.has(tNorm))
    return !inActive
  })

  // Dedupe: same telemetryTopic → keep first (newest), drop rest
  const seenTopics = new Set()
  const duplicateTags = []
  for (const t of existingTags) {
    if (orphanTags.some(o => o._id.toString() === t._id.toString())) continue
    const key = (t.telemetryTopic || `${normalizeIdentifier(t.parameterName)}|${(t.deviceName || '').toLowerCase()}`).toLowerCase()
    if (seenTopics.has(key)) {
      duplicateTags.push(t)
    } else {
      seenTopics.add(key)
    }
  }

  // Secondary dedupe: same gateway + normalized param + device
  const seenParamDevice = new Set()
  for (const t of existingTags) {
    if (orphanTags.some(o => o._id.toString() === t._id.toString())) continue
    if (duplicateTags.some(d => d._id.toString() === t._id.toString())) continue
    const key = `${normalizeIdentifier(t.parameterName)}|${(t.deviceName || '').toLowerCase()}`
    if (!normalizeIdentifier(t.parameterName)) continue
    if (seenParamDevice.has(key)) {
      duplicateTags.push(t)
    } else {
      seenParamDevice.add(key)
    }
  }

  const toDelete = [...orphanTags, ...duplicateTags]
  const deletedTagIds = [...new Set(toDelete.map(t => t._id))]

  let affectedUserIds = []

  if (deletedTagIds.length > 0) {
    console.log(`[tagSync] Reconciling tags: deleting ${orphanTags.length} orphan + ${duplicateTags.length} duplicate tags for gateway ${gwId}`)
    console.log(`[tagSync]   Orphan tags: ${orphanTags.map(t => t.parameterName || t.topicName).join(', ')}`)
    if (duplicateTags.length > 0) {
      console.log(`[tagSync]   Duplicate tags: ${duplicateTags.map(t => t.parameterName || t.topicName).join(', ')}`)
    }

    // 1. Find all users assigned any of these deleted tags
    const affectedUsers = await User.find({
      $or: [
        { assignedTagIds: { $in: deletedTagIds } },
        { 'assignedDigitalMeters.tagId': { $in: deletedTagIds } },
        { graphwl: { $in: deletedTagIds } }
      ]
    }).select('_id assignedTagIds assignedGatewayIds companyId').lean()
    affectedUserIds = affectedUsers.map(u => u._id)

    // 2. Pull deleted tag IDs from all users
    await Promise.all([
      User.updateMany(
        { assignedTagIds: { $in: deletedTagIds } },
        { $pull: { assignedTagIds: { $in: deletedTagIds } } }
      ),
      User.updateMany(
        { 'assignedDigitalMeters.tagId': { $in: deletedTagIds } },
        { $pull: { assignedDigitalMeters: { tagId: { $in: deletedTagIds } } } }
      ),
      User.updateMany(
        { graphwl: { $in: deletedTagIds } },
        { $pull: { graphwl: { $in: deletedTagIds } } }
      )
    ])

    // 3. Delete TelemetryTags, TelemetryReadings, and QuickInsightWidgets referencing deleted tags
    const QuickInsightWidget = require('../models/QuickInsightWidget')
    await Promise.all([
      TelemetryTag.deleteMany({ _id: { $in: deletedTagIds } }),
      TelemetryReading.deleteMany({ tagId: { $in: deletedTagIds } }),
      QuickInsightWidget.deleteMany({ tagId: { $in: deletedTagIds } })
    ])

    // 4. Recalculate assignedGatewayIds for affected users
    for (const user of affectedUsers) {
      const freshUser = await User.findById(user._id).select('assignedTagIds').lean()
      const remainingTagIds = freshUser?.assignedTagIds || []
      if (remainingTagIds.length > 0) {
        const remainingTags = await TelemetryTag.find({ _id: { $in: remainingTagIds } }).select('gatewayId').lean()
        const newGwIds = [...new Set(remainingTags.map(t => t.gatewayId?.toString()).filter(Boolean))]
        await User.findByIdAndUpdate(user._id, { assignedGatewayIds: newGwIds })
      } else {
        await User.findByIdAndUpdate(user._id, { assignedGatewayIds: [] })
      }
    }

    // 5. Invalidate / flush cache so dashboards & assign center reflect fresh tags
    cache.flush()

    // 6. Socket.IO real-time notification
    const io = appLocals.io
    if (io) {
      const strIds = deletedTagIds.map(id => id.toString())
      io.to('admins').emit('telemetry:tags-deleted', { gatewayId: gwId.toString(), tagIds: strIds })
      io.to('admins').emit('quick-insights:refresh-required', { gatewayId: gwId.toString(), deletedTagIds: strIds })
      try {
        const Gateway = require('../models/Gateway')
        const gw = await Gateway.findById(gwId).select('companyId').lean()
        if (gw?.companyId) {
          io.to(`company:${gw.companyId}`).emit('telemetry:tags-deleted', { gatewayId: gwId.toString(), tagIds: strIds })
          io.to(`company:${gw.companyId}`).emit('dashboard:refresh-required', {})
          io.to(`company:${gw.companyId}`).emit('quick-insights:refresh-required', { gatewayId: gwId.toString(), deletedTagIds: strIds })
        }
      } catch (_) {}

      affectedUserIds.forEach(uId => {
        const uIdStr = uId.toString()
        io.to(`employee:${uIdStr}`).emit('telemetry:assignments-updated', { gatewayId: gwId.toString(), deletedTagIds: strIds })
        io.to(`user:${uIdStr}`).emit('telemetry:assignments-updated', { gatewayId: gwId.toString(), deletedTagIds: strIds })
        io.to(`employee:${uIdStr}`).emit('quick-insights:refresh-required', { gatewayId: gwId.toString(), deletedTagIds: strIds })
      })
    }
  }

  return {
    orphanTagIds: orphanTags.map(t => t._id),
    duplicateTagIds: duplicateTags.map(t => t._id),
    affectedUserIds
  }
}

/**
 * Reconcile all gateways for a company (used before listing assign UIs).
 */
async function reconcileCompanyGatewayTags(companyId, appLocals = {}) {
  const Gateway = require('../models/Gateway')
  const gateways = await Gateway.find({ companyId }).select('_id').lean()
  let totalOrphans = 0
  let totalDupes = 0
  for (const gw of gateways) {
    const result = await reconcileGatewayTags(gw._id, appLocals)
    totalOrphans += result.orphanTagIds.length
    totalDupes += result.duplicateTagIds.length
  }
  return { totalOrphans, totalDupes, gatewayCount: gateways.length }
}

/**
 * Filter an in-memory tag list to only those present in latest GatewayConfig
 * for their gateway (no deletes — listing safety net).
 */
async function filterTagsToActiveConfigs(tags = []) {
  if (!tags.length) return []

  const gwIds = [...new Set(tags.map(t => (t.gatewayId?._id || t.gatewayId)?.toString()).filter(Boolean))]
  if (gwIds.length === 0) return tags

  const configs = await GatewayConfig.aggregate([
    { $match: { gatewayId: { $in: gwIds.map(id => new mongoose.Types.ObjectId(id)) } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$gatewayId', rows: { $first: '$rows' }, groups: { $first: '$groups' } } }
  ])

  const activeByGw = new Map()
  for (const cfg of configs) {
    const rows = cfg.rows?.length ? cfg.rows : (cfg.groups || []).flatMap(g => g.rows || [])
    activeByGw.set(cfg._id.toString(), activeIdentifiersFromRows(rows))
  }

  // Gateways with no config: keep all tags (can't decide)
  return tags.filter(t => {
    const gwId = (t.gatewayId?._id || t.gatewayId)?.toString()
    if (!gwId) return false
    const active = activeByGw.get(gwId)
    if (!active) return true
    if (active.size === 0) return false
    const pNorm = normalizeIdentifier(t.parameterName)
    const tNorm = normalizeIdentifier(t.topicName)
    return (pNorm && active.has(pNorm)) || (tNorm && active.has(tNorm))
  })
}

/**
 * Synchronize scaleFactor and decimal for all TelemetryTags from latest GatewayConfig records
 */
async function syncAllTagsFromConfig() {
  try {
    const GatewayConfig = require('../models/GatewayConfig')
    const TelemetryTag = require('../models/TelemetryTag')

    const configs = await GatewayConfig.aggregate([
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$gatewayId', latestDoc: { $first: '$$ROOT' } } }
    ])

    for (const item of configs) {
      const config = item.latestDoc
      const rows = config?.rows?.length
        ? config.rows
        : (config?.groups || []).flatMap(g => g.rows || [])

      for (const r of rows) {
        const pName = (r.parameterName || '').replace(/^[tp](\d+)$/i, 'P$1')
        const topicName = r.topicName ? r.topicName.replace(/^[tp](\d+)$/i, 'P$1') : pName
        const sfNum = (r.scaleFactor !== undefined && r.scaleFactor !== null && !isNaN(Number(r.scaleFactor))) ? Number(r.scaleFactor) : 1
        const decVal = (r.decimal !== undefined && r.decimal !== null && String(r.decimal).toLowerCase() !== 'none') ? Number(r.decimal) : 'None'

        const setFields = {
          scaleFactor: sfNum,
          decimal: decVal,
          deviceName: r.deviceName,
          todayMax: null,
          weekMax: null,
          yesterdayMax: null
        }
        if (r.unit && String(r.unit).trim() !== '') {
          setFields.unit = String(r.unit).trim()
        }

        await TelemetryTag.updateMany(
          {
            gatewayId: config.gatewayId,
            $or: [
              { parameterName: new RegExp(`^${pName}$`, 'i') },
              { topicName: new RegExp(`^${topicName}$`, 'i') },
              { address: r.address }
            ]
          },
          {
            $set: setFields
          }
        )
      }
    }
    console.log('[tagSync] Synchronized scaleFactor and decimal for all TelemetryTags from latest GatewayConfigs.')
  } catch (err) {
    console.error('[tagSync] Error during startup tag sync:', err.message)
  }
}

module.exports = {
  normalizeIdentifier,
  resolveExistingAssignedTagIds,
  countExistingAssignedTags,
  clearTagAssignmentsForGateway,
  reconcileGatewayTags,
  reconcileCompanyGatewayTags,
  filterTagsToActiveConfigs,
  syncAllTagsFromConfig
}
