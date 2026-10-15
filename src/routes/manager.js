const router = require('express').Router()
const createError = require('http-errors')
const User = require('../models/User')
const Gateway = require('../models/Gateway')
const TelemetryTag = require('../models/TelemetryTag')
const ReportExport = require('../models/ReportExport')
const QuickInsightBar = require('../models/QuickInsightBar')
const QuickInsightTab = require('../models/QuickInsightTab')
const QuickInsightWidget = require('../models/QuickInsightWidget')
const cache = require('../services/cache')
const influx = require('../services/influx')
const { logActivity } = require('../services/activityLogger')
const AssetTwinInstance = require('../models/AssetTwinInstance')
const { serializeQuickInsightWidgets } = require('../services/assetTwinService')
const {
  resolveExistingAssignedTagIds,
  countExistingAssignedTags,
  reconcileCompanyGatewayTags,
  filterTagsToActiveConfigs
} = require('../services/tagSync')

const TAG_PROJECTION = 'topicName parameterName displayName deviceName telemetryTopic unit gatewayId latestValue latestValueStr decimal latestArrivedAt todayMax yesterdayMax weekMax assignedGraphType assignedMeterType meterMin meterMax meterIdle meterColor assignedEmployeeIds warningThreshold criticalThreshold alertsEnabled'

// Always recompute liveValue from latestValue using current decimal config.
// Never use latestValueStr — it may be stale from a previous decimal config.
const formatTagLiveValue = (latestValue, decimal) => {
  if (latestValue === null || latestValue === undefined) return null
  const num = Number(latestValue)
  if (isNaN(num)) return String(latestValue)
  const isNone = decimal === null || decimal === undefined || String(decimal).toLowerCase() === 'none' || Number(decimal) === 0
  if (!isNone && !isNaN(Number(decimal)) && Number(decimal) > 0) {
    const d = parseInt(decimal, 10)
    const sign = num < 0 ? '-' : ''
    const absStr = Math.abs(num).toString()
    const parts = absStr.split('.')
    const intPart = parts[0]
    let fracPart = parts[1] || ''
    if (fracPart.length < d) {
      fracPart = fracPart.padEnd(d, '0')
    } else {
      fracPart = fracPart.slice(0, d)
    }
    return `${sign}${intPart}.${fracPart}`
  }
  // None = 0 decimal places, TRUNCATE (not round). 76.98 -> "76", NOT "77"
  return String(Math.trunc(num))
}

// Helper: Get list of employee IDs managed by this manager
const getManagedEmployeeIds = async (req) => {
  const companyId = req.user.companyId
  const employees = await User.find(
    { companyId, role: 'employee' },
    '_id'
  ).lean()
  return employees.map(e => e._id)
}

// Get list of employees under manager's scope
router.get('/employees', async (req, res, next) => {
  try {
    const companyId = req.user.companyId
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limitNum = Math.min(parseInt(req.query.limit, 10) || 200, 500)

    const total = await User.countDocuments({ companyId, role: 'employee' })
    const list = await User.find(
      { companyId, role: 'employee' },
      '-passwordHash -profilePhoto'
    )
      .sort({ name: 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean()

    res.json({ success: true, employees: list, total })
  } catch (error) {
    next(error)
  }
})

// Get managed users for Manager Users page
router.get('/users', async (req, res, next) => {
  try {
    if (req.user.featurePermissions?.showUsers === false) {
      throw createError(403, 'Forbidden: User management access is disabled for your account')
    }

    const companyId = req.user.companyId
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limitNum = Math.min(parseInt(req.query.limit, 10) || 200, 500)

    const filter = {
      companyId,
      role: 'employee'
    }

    const total = await User.countDocuments(filter)
    const employees = await User.find(
      filter,
      '_id name email active assignedTagIds assignedGatewayIds profilePhoto addressLabel'
    )
      .populate('assignedGatewayIds', 'name prefix')
      .populate('assignedTagIds', '_id parameterName displayName topicName')
      .sort({ name: 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean()

    const tagCounts = await countExistingAssignedTags(employees)

    const result = employees.map(emp => {
      const existingTags = (emp.assignedTagIds || []).filter(t => t && t._id)
      return {
        _id: emp._id.toString(),
        id: emp._id.toString(),
        name: emp.addressLabel || emp.name,
        addressLabel: emp.addressLabel || '',
        email: emp.email,
        active: emp.active,
        assignedTagCount: tagCounts.get(emp._id.toString()) || 0,
        assignedGatewayCount: (emp.assignedGatewayIds || []).length,
        assignedGatewayIds: emp.assignedGatewayIds || [],
        assignedTags: existingTags,
        profilePhoto: emp.profilePhoto || ''
      }
    })

    res.json({ success: true, users: result, employees: result, total })
  } catch (error) {
    next(error)
  }
})

// Get gateway-wise tags for a managed employee
router.get('/users/:userId/gateway-tags', async (req, res, next) => {
  try {
    if (req.user.featurePermissions?.showUsers === false) {
      throw createError(403, 'Forbidden: User management access is disabled for your account')
    }

    const { userId } = req.params
    const companyId = req.user.companyId

    const employee = await User.findOne({
      _id: userId,
      companyId,
      role: 'employee',
      managerId: req.user._id
    }).select('_id name email assignedTagIds assignedGatewayIds').lean()

    if (!employee) {
      throw createError(404, 'Employee not found or not assigned under your management')
    }

    try {
      await reconcileCompanyGatewayTags(companyId, req.app.locals)
    } catch (reconcileErr) {
      console.error('[tagSync] manager gateway-tags reconcile failed:', reconcileErr.message)
    }

    const assignedSet = new Set(
      await resolveExistingAssignedTagIds(employee.assignedTagIds || [], { pruneUserId: employee._id })
    )

    const gateways = await Gateway.find({ companyId }).sort({ name: 1 }).lean()
    let allTags = await TelemetryTag.find({ companyId })
      .sort({ parameterName: 1 })
      .collation({ locale: 'en', numericOrdering: true })
      .lean()

    allTags = await filterTagsToActiveConfigs(allTags)

    const tagsByGateway = new Map()
    const seen = new Set()
    allTags.forEach(tag => {
      const gwId = tag.gatewayId?.toString()
      if (!gwId) return
      const dedupeKey = `${gwId}|${(tag.parameterName || '').toUpperCase()}|${(tag.deviceName || '').toLowerCase()}|${(tag.topicName || '').toUpperCase()}`
      if (seen.has(dedupeKey)) return
      seen.add(dedupeKey)
      if (!tagsByGateway.has(gwId)) tagsByGateway.set(gwId, [])
      tagsByGateway.get(gwId).push({
        _id: tag._id.toString(),
        parameterName: tag.parameterName,
        displayName: tag.displayName || '',
        topicName: tag.topicName,
        deviceName: tag.deviceName,
        unit: tag.unit || '',
        address: tag.address ?? null,
        assigned: assignedSet.has(tag._id.toString())
      })
    })

    const gatewaySections = gateways.map(gw => ({
      gatewayId: gw._id.toString(),
      gatewayName: gw.name,
      gatewayPrefix: gw.prefix,
      location: gw.location || '',
      tags: tagsByGateway.get(gw._id.toString()) || []
    }))

    res.json({
      success: true,
      employee: {
        _id: employee._id.toString(),
        name: employee.name,
        email: employee.email,
        assignedTagCount: assignedSet.size
      },
      gateways: gatewaySections
    })
  } catch (error) {
    next(error)
  }
})

// Save tag assignments for a managed employee
router.put('/users/:userId/assign-tags', async (req, res, next) => {
  try {
    if (req.user.featurePermissions?.showUsers === false) {
      throw createError(403, 'Forbidden: User management access is disabled for your account')
    }

    const { userId } = req.params
    const { assignedTagIds } = req.body
    const companyId = req.user.companyId

    if (!Array.isArray(assignedTagIds)) {
      throw createError(400, 'assignedTagIds must be an array of tag IDs')
    }

    const cleanTagIds = [...new Set(assignedTagIds.filter(Boolean))]

    const employee = await User.findOne({
      _id: userId,
      companyId,
      role: 'employee',
      managerId: req.user._id
    })

    if (!employee) {
      throw createError(404, 'Employee not found or not assigned under your management')
    }

    const validTags = await TelemetryTag.find({
      _id: { $in: cleanTagIds },
      companyId
    }).select('_id gatewayId').lean()

    if (validTags.length !== cleanTagIds.length) {
      throw createError(400, 'One or more selected tags are invalid or belong to another company')
    }

    const previousTagIds = (employee.assignedTagIds || []).map(id => id.toString())
    const newTagIdSet = new Set(cleanTagIds)
    const prevTagIdSet = new Set(previousTagIds)

    const removedTagIds = previousTagIds.filter(id => !newTagIdSet.has(id))
    const addedTagIds = cleanTagIds.filter(id => !prevTagIdSet.has(id))

    if (removedTagIds.length > 0) {
      await TelemetryTag.updateMany(
        { _id: { $in: removedTagIds } },
        { $pull: { assignedEmployeeIds: employee._id } }
      )
    }

    if (addedTagIds.length > 0) {
      await TelemetryTag.updateMany(
        { _id: { $in: addedTagIds } },
        { $addToSet: { assignedEmployeeIds: employee._id } }
      )
    }

    const assignedGatewayIds = [...new Set(validTags.map(t => t.gatewayId?.toString()).filter(Boolean))]

    employee.assignedTagIds = cleanTagIds
    employee.assignedGatewayIds = assignedGatewayIds
    await employee.save()

    cache.flush()

    const io = req.app.locals.io
    if (io) {
      const empIdStr = employee._id.toString()
      io.to(`employee:${empIdStr}`).emit('telemetry:assignments-updated', { employeeId: empIdStr })
      io.to(`user:${empIdStr}`).emit('telemetry:assignments-updated', { employeeId: empIdStr })
      io.to(`company:${companyId.toString()}`).emit('telemetry:assignments-updated', { employeeId: empIdStr })
      io.to(`company:${companyId.toString()}`).emit('dashboard:refresh-required', {})
    }

    logActivity({
      user: req.user,
      companyId,
      action: 'UPDATE_EMPLOYEE_TAGS',
      category: 'User',
      details: `Manager assigned ${cleanTagIds.length} telemetry tag(s) across ${assignedGatewayIds.length} gateway(s) to Employee ${employee.name}`,
      req
    })

    res.json({
      success: true,
      message: 'Employee tag assignments updated successfully',
      employee: {
        _id: employee._id.toString(),
        name: employee.name,
        assignedTagCount: cleanTagIds.length,
        assignedGatewayCount: assignedGatewayIds.length
      }
    })
  } catch (error) {
    next(error)
  }
})

// Get gateways list under manager's company scope
router.get('/gateways', async (req, res, next) => {
  try {
    const companyId = req.user.companyId
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limitNum = Math.max(1, parseInt(req.query.limit, 10) || 10)
    const { search } = req.query

    const filter = { companyId }
    if (search) {
      filter.$or = [
        { name: new RegExp(search, 'i') },
        { prefix: new RegExp(search, 'i') },
        { location: new RegExp(search, 'i') }
      ]
    }

    const total = await Gateway.countDocuments(filter)
    const list = await Gateway.find(filter)
      .sort({ name: 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean()

    res.json({ success: true, gateways: list, total, page: pageNum, limit: limitNum })
  } catch (error) {
    next(error)
  }
})

// Get manager dashboard tag summary
router.get('/dashboard', async (req, res, next) => {
  try {
    const { employeeId } = req.query
    const companyId = req.user.companyId
    const cacheKey = `mgr_dash:${companyId}:${employeeId || 'all'}`
    const cached = cache.get(cacheKey)
    if (cached) return res.json(cached)

    let tagFilter = { companyId }

    if (employeeId && employeeId !== 'all') {
      const employee = await User.findOne(
        { _id: employeeId, companyId, role: 'employee' },
        'assignedTagIds'
      ).lean()
      if (!employee) throw createError(404, 'Employee not found')
      const existingIds = await resolveExistingAssignedTagIds(employee.assignedTagIds || [], {
        pruneUserId: employee._id
      })
      if (existingIds.length === 0) {
        const payload = { success: true, tags: [] }
        cache.set(cacheKey, payload)
        return res.json(payload)
      }
      tagFilter._id = { $in: existingIds }
    } else {
      const managedIds = await getManagedEmployeeIds(req)
      if (managedIds.length === 0) {
        return res.json({ success: true, tags: [] })
      }
      tagFilter.assignedEmployeeIds = { $in: managedIds }
    }

    const limitNum = Math.min(parseInt(req.query.limit, 10) || 200, 500)
    const tags = await TelemetryTag.find(tagFilter, TAG_PROJECTION)
      .populate('gatewayId', 'name prefix')
      .populate('assignedEmployeeIds', '_id name email')
      .sort({ parameterName: 1 })
      .collation({ locale: 'en', numericOrdering: true })
      .limit(limitNum)
      .lean()

    if (tags.length === 0) {
      return res.json({ success: true, tags: [] })
    }

    const tagSummaries = tags.map((tag) => {
      return {
        _id: tag._id,
        gatewayId: tag.gatewayId,
        topicName: tag.topicName,
        parameterName: tag.parameterName,
        displayName: tag.displayName || '',
        deviceName: tag.deviceName,
        unit: tag.unit || '',
        latestValue: tag.latestValue,
        latestArrivedAt: tag.latestArrivedAt,
        todayMax: tag.todayMax ?? 0,
        yesterdayMax: tag.yesterdayMax ?? 0,
        weekMax: tag.weekMax ?? 0,
        assignedGraphType: tag.assignedGraphType || null,
        assignedMeterType: tag.assignedMeterType || null,
        meterMin: tag.meterMin ?? null,
        meterMax: tag.meterMax ?? null,
        meterIdle: tag.meterIdle ?? 0,
        meterColor: tag.meterColor || '#22c55e',
        assignedEmployees: tag.assignedEmployeeIds || [],
        warningThreshold: tag.warningThreshold !== undefined ? tag.warningThreshold : null,
        criticalThreshold: tag.criticalThreshold !== undefined ? tag.criticalThreshold : null,
        alertsEnabled: tag.alertsEnabled !== false
      }
    })

    const payload = { success: true, tags: tagSummaries }
    cache.set(cacheKey, payload)
    res.json(payload)
  } catch (error) {
    next(error)
  }
})

// Get telemetry list (paginated, with summary enrichments)
router.get('/telemetry', async (req, res, next) => {
  try {
    const { employeeId, search, page, limit, gatewayId } = req.query
    const companyId = req.user.companyId

    let filter = { companyId }
    if (employeeId && employeeId !== 'all') {
      const employee = await User.findOne(
        { _id: employeeId, companyId, role: 'employee' },
        'assignedTagIds'
      ).lean()
      if (!employee) throw createError(404, 'Employee not found')
      const existingIds = await resolveExistingAssignedTagIds(employee.assignedTagIds || [], {
        pruneUserId: employee._id
      })
      if (existingIds.length === 0) {
        return res.json({ success: true, tags: [], total: 0, page: parseInt(page, 10) || 1, limit: parseInt(limit, 10) || 10 })
      }
      filter._id = { $in: existingIds }
    }

    if (gatewayId) {
      filter.gatewayId = gatewayId
    }

    if (search) {
      const q = search.trim()
      filter.$or = [
        { topicName: { $regex: q, $options: 'i' } },
        { parameterName: { $regex: q, $options: 'i' } },
        { displayName: { $regex: q, $options: 'i' } },
        { deviceName: { $regex: q, $options: 'i' } }
      ]
    }

    const pageNum = parseInt(page, 10) || 1
    const limitNum = parseInt(limit, 10) || 12

    const total = await TelemetryTag.countDocuments(filter)

    const tags = await TelemetryTag.find(filter, TAG_PROJECTION)
      .populate('gatewayId', 'name prefix status')
      .populate('assignedEmployeeIds', '_id name email')
      .sort({ parameterName: 1 })
      .collation({ locale: 'en', numericOrdering: true })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean()

    if (tags.length === 0) {
      return res.json({ success: true, tags: [], total })
    }

    const tagSummaries = tags.map((tag) => {
      const tagIdStr = tag._id.toString()
      return {
        _id: tagIdStr,
        tagId: tagIdStr,
        parameterName: tag.parameterName,
        displayName: tag.displayName || '',
        deviceName: tag.deviceName,
        topicName: tag.topicName,
        telemetryTopic: tag.telemetryTopic,
        unit: tag.unit,
        gateway: tag.gatewayId ? { id: tag.gatewayId._id, name: tag.gatewayId.name, prefix: tag.gatewayId.prefix, status: tag.gatewayId.status } : null,
        decimal: tag.decimal ?? 'None',
        liveValue: formatTagLiveValue(tag.latestValue, tag.decimal),
        arrivedAt: tag.latestArrivedAt ?? null,
        todayMax: tag.todayMax ?? 0,
        yesterdayMax: tag.yesterdayMax ?? 0,
        weekMax: tag.weekMax ?? 0,
        assignedGraphType: tag.assignedGraphType || null,
        assignedMeterType: tag.assignedMeterType || null,
        meterMin: tag.meterMin ?? null,
        meterMax: tag.meterMax ?? null,
        meterIdle: tag.meterIdle ?? 0,
        meterColor: tag.meterColor || '#22c55e',
        assignedEmployees: tag.assignedEmployeeIds || [],
        warningThreshold: tag.warningThreshold !== undefined ? tag.warningThreshold : null,
        criticalThreshold: tag.criticalThreshold !== undefined ? tag.criticalThreshold : null,
        alertsEnabled: tag.alertsEnabled !== false
      }
    })

    res.json({ success: true, tags: tagSummaries, total })
  } catch (error) {
    next(error)
  }
})

// Get telemetry historical readings for graphs
router.get('/readings', async (req, res, next) => {
  try {
    const { tagId, limit = 20, startDate, endDate } = req.query
    if (!tagId) throw createError(400, 'tagId is required')

    const tag = await TelemetryTag.findOne(
      { _id: tagId, companyId: req.user.companyId },
      '_id'
    ).lean()
    if (!tag) throw createError(404, 'Tag not found')

    const list = await influx.queryReadings({
      tagId,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      limit: parseInt(limit, 10)
    })

    res.json({ success: true, readings: list })
  } catch (error) {
    next(error)
  }
})

// Get report readings
router.get('/report', async (req, res, next) => {
  try {
    const { employeeId, tagId, startDate, endDate } = req.query
    const companyId = req.user.companyId

    let tagIds = []

    if (tagId && tagId !== 'all') {
      const tag = await TelemetryTag.findOne({ _id: tagId, companyId }, '_id').lean()
      if (tag) tagIds.push(tag._id)
    } else if (employeeId && employeeId !== 'all') {
      const employee = await User.findOne(
        { _id: employeeId, companyId, role: 'employee' },
        'assignedTagIds'
      ).lean()
      if (employee) tagIds = employee.assignedTagIds
    } else {
      const managedIds = await getManagedEmployeeIds(req)
      const tags = await TelemetryTag.find(
        { companyId, assignedEmployeeIds: { $in: managedIds } },
        '_id'
      ).limit(500).lean()
      tagIds = tags.map(t => t._id)
    }

    if (!tagIds || tagIds.length === 0) {
      const allCompanyTags = await TelemetryTag.find({ companyId }, '_id').limit(500).lean()
      tagIds = allCompanyTags.map(t => t._id)
    }

    const pageNum = parseInt(req.query.page) || 1
    const limitNum = parseInt(req.query.limit) || 50
    const skip = (pageNum - 1) * limitNum

    if (!tagIds || tagIds.length === 0) {
      return res.json({
        success: true,
        readings: [],
        total: 0,
        page: pageNum,
        totalPages: 0,
        reason: 'no_tags'
      })
    }

    const [total, readings] = await Promise.all([
      influx.countReadings({
        tagIds,
        startDate: startDate || undefined,
        endDate: endDate || undefined
      }),
      influx.queryReadingsInTags({
        tagIds,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        limit: limitNum,
        skip
      })
    ])

    const tagsMap = {}
    if (readings.length > 0) {
      const uniqueTagIds = [...new Set(readings.map(r => r.tagId.toString()))]
      const tagsList = await TelemetryTag.find(
        { _id: { $in: uniqueTagIds } },
        'parameterName displayName topicName deviceName unit decimal'
      ).lean()
      tagsList.forEach(t => { tagsMap[t._id.toString()] = t })
    }

    const formattedReadings = readings.map(r => {
      const tagObj = tagsMap[r.tagId.toString()]
      const formattedVal = formatTagLiveValue(r.value, tagObj ? tagObj.decimal : 'None')
      return {
        id: r._id ? r._id.toString() : (r.arrivedAt ? new Date(r.arrivedAt).toISOString() : new Date().toISOString()),
        tagId: r.tagId.toString(),
        parameterName: tagObj ? tagObj.parameterName : '',
        displayName: tagObj ? tagObj.displayName : '',
        topicName: tagObj ? tagObj.topicName : '',
        deviceName: tagObj ? tagObj.deviceName : '',
        unit: tagObj ? tagObj.unit : '',
        value: formattedVal !== null ? formattedVal : r.value,
        timestamp: r.arrivedAt ? new Date(r.arrivedAt).toISOString() : new Date().toISOString()
      }
    })

    res.json({
      success: true,
      readings: formattedReadings,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum)
    })
  } catch (error) {
    next(error)
  }
})

// Create Report Export log
router.post('/report/export', async (req, res, next) => {
  try {
    const { employeeId, filters, format } = req.body
    const companyId = req.user.companyId
    const exportFormat = format || filters?.format || 'csv'

    const reportLog = await ReportExport.create({
      companyId,
      employeeId: employeeId || null,
      generatedBy: req.user._id,
      filters: filters || {},
      format: exportFormat
    })

    res.json({ success: true, reportLog })
  } catch (error) {
    next(error)
  }
})

// Backend-driven Report File Download (CSV / JSON)
router.get('/report/download', async (req, res, next) => {
  try {
    const { employeeId, tagId, startDate, endDate, format } = req.query
    const companyId = req.user.companyId
    const exportFormat = (format || 'csv').toLowerCase() === 'json' ? 'json' : 'csv'

    let tagIds = []

    if (tagId && tagId !== 'all') {
      const tag = await TelemetryTag.findOne({ _id: tagId, companyId }, '_id').lean()
      if (tag) tagIds.push(tag._id)
    } else if (employeeId && employeeId !== 'all') {
      const employee = await User.findOne(
        { _id: employeeId, companyId, role: 'employee' },
        'assignedTagIds'
      ).lean()
      if (employee) tagIds = employee.assignedTagIds || []
    } else {
      const managedIds = await getManagedEmployeeIds(req)
      const tags = await TelemetryTag.find(
        { companyId, assignedEmployeeIds: { $in: managedIds } },
        '_id'
      ).limit(1000).lean()
      tagIds = tags.map(t => t._id)
    }

    if (!tagIds || tagIds.length === 0) {
      const allCompanyTags = await TelemetryTag.find({ companyId }, '_id').limit(1000).lean()
      tagIds = allCompanyTags.map(t => t._id)
    }

    if (!tagIds || tagIds.length === 0) {
      throw createError(400, 'No telemetry tags available for the specified criteria')
    }

    const readings = await influx.queryReadingsInTags({
      tagIds,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      limit: 50000,
      skip: 0
    })

    const tagsMap = {}
    if (readings.length > 0) {
      const uniqueTagIds = [...new Set(readings.map(r => r.tagId.toString()))]
      const tagsList = await TelemetryTag.find(
        { _id: { $in: uniqueTagIds } },
        'parameterName displayName topicName deviceName unit decimal'
      ).lean()
      tagsList.forEach(t => { tagsMap[t._id.toString()] = t })
    }

    const formattedReadings = readings.map(r => {
      const tagObj = tagsMap[r.tagId.toString()]
      const formattedVal = formatTagLiveValue(r.value, tagObj ? tagObj.decimal : 'None')
      return {
        id: r._id.toString(),
        tagId: r.tagId.toString(),
        parameterName: tagObj ? tagObj.parameterName : '',
        displayName: tagObj ? tagObj.displayName : '',
        topicName: tagObj ? tagObj.topicName : '',
        deviceName: tagObj ? tagObj.deviceName : '',
        unit: tagObj ? tagObj.unit : '',
        value: formattedVal !== null ? formattedVal : r.value,
        timestamp: r.arrivedAt ? new Date(r.arrivedAt).toISOString() : new Date().toISOString()
      }
    })

    // Log export asynchronously
    ReportExport.create({
      companyId,
      employeeId: employeeId && employeeId !== 'all' ? employeeId : null,
      generatedBy: req.user._id,
      filters: { tagId, startDate, endDate },
      format: exportFormat
    }).catch(err => console.warn('Failed to log report export:', err.message))

    const dateStr = new Date().toISOString().split('T')[0]
    if (exportFormat === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="report_${dateStr}.json"`)
      return res.send(JSON.stringify(formattedReadings, null, 2))
    }

    // CSV format
    const headers = ['Timestamp', 'Device Name', 'Parameter Label', 'Value', 'Unit']
    const rows = formattedReadings.map(r => [
      r.timestamp,
      `"${(r.deviceName || '').replace(/"/g, '""')}"`,
      `"${(r.displayName || r.parameterName || r.topicName || '').replace(/"/g, '""')}"`,
      r.value !== null && r.value !== undefined ? r.value : '',
      `"${(r.unit || '').replace(/"/g, '""')}"`
    ])
    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(row => row.join(','))].join('\r\n')

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="report_${dateStr}.csv"`)
    return res.send(csvContent)
  } catch (error) {
    next(error)
  }
})

// Get scoped gateways list for manager
router.get('/gateways', async (req, res, next) => {
  try {
    const { employeeId } = req.query
    const companyId = req.user.companyId

    let filter = { companyId }
    if (employeeId && employeeId !== 'all') {
      const employee = await User.findOne({ _id: employeeId, companyId, role: 'employee' })
      if (!employee) throw createError(404, 'Employee not found')
      filter._id = { $in: employee.assignedGatewayIds }
    }

    const list = await Gateway.find(filter, 'name prefix status').lean()
    res.json({ success: true, gateways: list })
  } catch (error) {
    next(error)
  }
})

// Get manager dashboard summary counts
router.get('/dashboard-summary', async (req, res, next) => {
  try {
    const { employeeId } = req.query
    const companyId = req.user.companyId

    let tagFilter = { companyId }
    let gatewayFilter = { companyId }
    let employeeCount = 0

    if (employeeId && employeeId !== 'all') {
      const employee = await User.findOne(
        { _id: employeeId, companyId, role: 'employee' },
        'assignedTagIds'
      ).lean()
      if (!employee) throw createError(404, 'Employee not found')
      const existingIds = await resolveExistingAssignedTagIds(employee.assignedTagIds || [], {
        pruneUserId: employee._id
      })
      tagFilter._id = { $in: existingIds }
      employeeCount = 1

      const assignedTags = existingIds.length
        ? await TelemetryTag.find(tagFilter, 'gatewayId').lean()
        : []
      const uniqueGwIds = [...new Set(assignedTags.map(t => t.gatewayId?.toString()).filter(Boolean))]
      gatewayFilter._id = { $in: uniqueGwIds }
    } else {
      employeeCount = await User.countDocuments({ companyId, role: 'employee' })
    }

    const [totalGateways, onlineGateways, activeTags] = await Promise.all([
      Gateway.countDocuments(gatewayFilter),
      Gateway.countDocuments({ ...gatewayFilter, status: 'online' }),
      TelemetryTag.countDocuments(tagFilter)
    ])

    res.json({
      success: true,
      summary: {
        totalEmployees: employeeCount,
        totalGateways,
        onlineGateways,
        activeTags
      }
    })
  } catch (error) {
    next(error)
  }
})

// Rename a specific telemetry tag's display label
router.put('/telemetry/:tagId/rename', async (req, res, next) => {
  try {
    const { displayName } = req.body
    const companyId = req.user.companyId

    const tag = await TelemetryTag.findOneAndUpdate(
      { _id: req.params.tagId, companyId },
      { $set: { displayName: (displayName || '').trim() } },
      { new: true }
    )

    if (!tag) throw createError(404, 'Telemetry tag not found')

    res.json({ success: true, message: 'Tag label updated successfully', tag })
  } catch (error) {
    next(error)
  }
})

// ----------------------------------------------------
// THRESHOLDS MANAGEMENT (MANAGER)
// ----------------------------------------------------
router.get('/thresholds', async (req, res, next) => {
  try {
    const { employeeId, gatewayId, search, page, limit } = req.query
    const companyId = req.user.companyId
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100)

    let filter = { companyId }

    if (gatewayId && gatewayId !== 'all') {
      filter.gatewayId = gatewayId
    }

    if (employeeId && employeeId !== 'all') {
      const employee = await User.findOne({ _id: employeeId, companyId, role: 'employee' }).select('assignedTagIds').lean()
      if (employee) {
        filter._id = { $in: employee.assignedTagIds || [] }
      } else {
        return res.json({ success: true, tags: [], total: 0, page: pageNum, limit: limitNum })
      }
    }

    if (search) {
      const q = search.trim()
      filter.$or = [
        { topicName: { $regex: q, $options: 'i' } },
        { parameterName: { $regex: q, $options: 'i' } },
        { displayName: { $regex: q, $options: 'i' } },
        { deviceName: { $regex: q, $options: 'i' } }
      ]
    }

    const total = await TelemetryTag.countDocuments(filter)
    const tags = await TelemetryTag.find(filter)
      .populate('gatewayId', 'name prefix')
      .populate('assignedEmployeeIds', 'name email')
      .sort({ parameterName: 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean()

    res.json({ success: true, tags, total, page: pageNum, limit: limitNum })
  } catch (error) {
    next(error)
  }
})

router.put('/thresholds/:tagId', async (req, res, next) => {
  try {
    const { warningThreshold, criticalThreshold, alertsEnabled } = req.body
    const companyId = req.user.companyId

    const wVal = warningThreshold !== undefined && warningThreshold !== '' && warningThreshold !== null ? Number(warningThreshold) : null
    const cVal = criticalThreshold !== undefined && criticalThreshold !== '' && criticalThreshold !== null ? Number(criticalThreshold) : null

    if (wVal !== null && isNaN(wVal)) throw createError(400, 'Warning threshold must be a valid number')
    if (cVal !== null && isNaN(cVal)) throw createError(400, 'Critical threshold must be a valid number')

    if (wVal !== null && cVal !== null && wVal >= cVal) {
      throw createError(400, 'Warning threshold must be strictly less than Critical threshold')
    }

    const updateData = {
      warningThreshold: wVal,
      criticalThreshold: cVal
    }

    if (alertsEnabled !== undefined) {
      updateData.alertsEnabled = Boolean(alertsEnabled)
    }

    const tag = await TelemetryTag.findOneAndUpdate(
      { _id: req.params.tagId, companyId },
      updateData,
      { new: true }
    )
      .populate('gatewayId', 'name prefix')
      .populate('assignedEmployeeIds', 'name email')

    if (!tag) throw createError(404, 'Telemetry Tag not found')

    cache.flush()

    logActivity({
      user: req.user,
      companyId: tag.companyId,
      action: 'UPDATE_THRESHOLD',
      category: 'Telemetry',
      details: `Manager updated threshold settings for parameter "${tag.parameterName}" (${tag.displayName || tag.topicName})`,
      req
    })

    res.json({ success: true, tag, message: 'Threshold settings updated successfully' })
  } catch (error) {
    next(error)
  }
})

// Get managed employees with assigned parameters count for Assign feature
router.get('/assign/employees', async (req, res, next) => {
  try {
    const companyId = req.user.companyId
    const employees = await User.find(
      { companyId, role: 'employee' },
      '_id name email active assignedTagIds profilePhoto addressLabel'
    ).lean()

    const tagCounts = await countExistingAssignedTags(employees)

    const result = employees.map(emp => ({
      _id: emp._id.toString(),
      id: emp._id.toString(),
      name: emp.addressLabel || emp.name,
      addressLabel: emp.addressLabel || '',
      email: emp.email,
      active: emp.active,
      assignedTagCount: tagCounts.get(emp._id.toString()) || 0,
      profilePhoto: emp.profilePhoto || ''
    }))

    res.json({ success: true, employees: result })
  } catch (error) {
    next(error)
  }
})

// Get tags for assignment modal (filtering by employee, search, paginated)
router.get('/assign/tags', async (req, res, next) => {
  try {
    const { employeeId, search, page, limit } = req.query
    const companyId = req.user.companyId

    let filter = { companyId }
    if (employeeId && employeeId !== 'all') {
      const employee = await User.findOne(
        { _id: employeeId, companyId, role: 'employee' },
        'assignedTagIds'
      ).lean()
      if (!employee) throw createError(404, 'Employee not found')

      const existingIds = await resolveExistingAssignedTagIds(employee.assignedTagIds || [], {
        pruneUserId: employee._id
      })

      if (existingIds.length === 0) {
        return res.json({ success: true, tags: [], total: 0 })
      }
      filter._id = { $in: existingIds }
    }

    if (search) {
      const q = search.trim()
      filter.$or = [
        { topicName: { $regex: q, $options: 'i' } },
        { parameterName: { $regex: q, $options: 'i' } },
        { displayName: { $regex: q, $options: 'i' } },
        { deviceName: { $regex: q, $options: 'i' } }
      ]
    }

    const pageNum = parseInt(page, 10) || 1
    const limitNum = parseInt(limit, 10) || 10

    // For company-wide listing, reconcile orphans then paginate normally
    if (!employeeId || employeeId === 'all') {
      try {
        if (gatewayId && gatewayId !== 'all') {
          const { reconcileGatewayTags } = require('../services/tagSync')
          await reconcileGatewayTags(gatewayId, req.app.locals)
        } else {
          await reconcileCompanyGatewayTags(companyId, req.app.locals)
        }
      } catch (reconcileErr) {
        console.error('[tagSync] assign/tags reconcile failed:', reconcileErr.message)
      }
    }

    const total = await TelemetryTag.countDocuments(filter)
    const tags = await TelemetryTag.find(filter, TAG_PROJECTION)
      .populate('gatewayId', 'name prefix')
      .populate('assignedEmployeeIds', '_id name email')
      .sort({ parameterName: 1 })
      .collation({ locale: 'en', numericOrdering: true })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean()

    const mapped = tags.map(tag => ({
      _id: tag._id.toString(),
      tagId: tag._id.toString(),
      parameterName: tag.parameterName,
      displayName: tag.displayName || '',
      deviceName: tag.deviceName,
      topicName: tag.topicName,
      unit: tag.unit || '',
      liveValue: tag.latestValue ?? null,
      gateway: tag.gatewayId ? { id: tag.gatewayId._id, name: tag.gatewayId.name, prefix: tag.gatewayId.prefix } : null,
      assignedGraphType: tag.assignedGraphType || null,
      assignedMeterType: tag.assignedMeterType || null,
      meterMin: tag.meterMin ?? null,
      meterMax: tag.meterMax ?? null,
      meterIdle: tag.meterIdle ?? 0,
      meterColor: tag.meterColor || '#22c55e',
      assignedEmployees: tag.assignedEmployeeIds || []
    }))

    res.json({ success: true, tags: mapped, total })
  } catch (error) {
    next(error)
  }
})

// Assign graph or meter visualization to a tag
router.post('/assign', async (req, res, next) => {
  try {
    const { tagId, type, value, meterMin, meterMax, meterColor, meterIdle } = req.body
    const companyId = req.user.companyId

    if (!tagId) throw createError(400, 'tagId is required')
    if (!type || !['graph', 'meter', 'clear_graph', 'clear_meter', 'clear_all'].includes(type)) {
      throw createError(400, 'Invalid assignment type')
    }

    let updateData = {}
    if (type === 'graph') {
      if (!value) throw createError(400, 'Graph visualization type value is required')
      updateData.assignedGraphType = value
    } else if (type === 'meter') {
      if (!value) throw createError(400, 'Digital meter type value is required')
      updateData.assignedMeterType = value
      updateData.meterMin = meterMin !== undefined && meterMin !== null && meterMin !== '' ? Number(meterMin) : 0
      updateData.meterMax = meterMax !== undefined && meterMax !== null && meterMax !== '' ? Number(meterMax) : 100
      updateData.meterIdle = meterIdle !== undefined && meterIdle !== null && meterIdle !== '' ? Number(meterIdle) : 0
      updateData.meterColor = meterColor || '#22c55e'
    } else if (type === 'clear_graph') {
      updateData.assignedGraphType = null
    } else if (type === 'clear_meter') {
      updateData.assignedMeterType = null; updateData.meterMin = null; updateData.meterMax = null; updateData.meterIdle = 0; updateData.meterColor = null
    } else if (type === 'clear_all') {
      updateData.assignedGraphType = null; updateData.assignedMeterType = null; updateData.meterMin = null; updateData.meterMax = null; updateData.meterIdle = 0; updateData.meterColor = null
    }

    const tag = await TelemetryTag.findOneAndUpdate(
      { _id: tagId, companyId },
      updateData,
      { new: true }
    ).lean()

    if (!tag) throw createError(404, 'Telemetry Tag not found')

    logActivity({
      user: req.user,
      companyId,
      action: 'ASSIGN_VISUALIZATION',
      category: 'Telemetry',
      details: `Manager assigned ${type} visualization (${value || 'clear'}) to parameter "${tag.parameterName}"`,
      req
    })

    res.json({
      success: true,
      message: 'Visualization assignment updated successfully',
      tag: {
        _id: tag._id.toString(),
        assignedGraphType: tag.assignedGraphType,
        assignedMeterType: tag.assignedMeterType,
        meterMin: tag.meterMin,
        meterMax: tag.meterMax,
        meterIdle: tag.meterIdle,
        meterColor: tag.meterColor
      }
    })
  } catch (error) {
    next(error)
  }
})

// ─── QUICK INSIGHTS v1 (bars — preserved for legacy) ────────────────────────

router.get('/quick-insights', async (req, res, next) => {
  try {
    const managerId = req.user._id
    const companyId = req.user.companyId
    const bars = await QuickInsightBar.find({ managerId, companyId }).sort({ order: 1, createdAt: 1 }).lean()
    const tagIds = bars.map(b => b.tagId)
    const tags = await TelemetryTag.find({ _id: { $in: tagIds } }, 'topicName parameterName displayName deviceName latestValue latestValueStr unit assignedEmployeeIds').lean()
    const tagMap = {}; tags.forEach(t => { tagMap[t._id.toString()] = t })
    const allEmpIds = [...new Set(tags.flatMap(t => (t.assignedEmployeeIds || []).map(id => id.toString())))]
    const employees = await User.find({ _id: { $in: allEmpIds } }, 'name email').lean()
    const empMap = {}; employees.forEach(e => { empMap[e._id.toString()] = { name: e.name, email: e.email } })
    const result = bars.map(bar => {
      const tag = tagMap[bar.tagId.toString()] || {}
      return { ...bar, tag: { _id: tag._id, topicName: tag.topicName, parameterName: tag.parameterName, displayName: tag.displayName, deviceName: tag.deviceName, latestValue: tag.latestValue, latestValueStr: tag.latestValueStr, unit: tag.unit }, assignedEmployees: (tag.assignedEmployeeIds || []).map(id => empMap[id.toString()]).filter(Boolean) }
    })
    res.json({ success: true, bars: result })
  } catch (error) { next(error) }
})

router.post('/quick-insights', async (req, res, next) => {
  try {
    const managerId = req.user._id; const companyId = req.user.companyId; const { tagId, color, minValue, maxValue, idleValue } = req.body
    if (!tagId) throw createError(400, 'tagId is required')
    const tag = await TelemetryTag.findOne({ _id: tagId, companyId }).lean()
    if (!tag) throw createError(404, 'Tag not found')
    const last = await QuickInsightBar.findOne({ managerId, companyId }).sort({ order: -1 }).lean()
    const order = last ? last.order + 1 : 0
    const bar = await QuickInsightBar.create({ companyId, managerId, tagId, color: color || '#22c55e', minValue: minValue !== undefined ? Number(minValue) : -140, maxValue: maxValue !== undefined ? Number(maxValue) : 140, idleValue: idleValue !== undefined ? Number(idleValue) : 0, order })
    res.json({ success: true, bar })
  } catch (error) { next(error) }
})

router.put('/quick-insights/:barId', async (req, res, next) => {
  try {
    const managerId = req.user._id; const { barId } = req.params; const { tagId, color, minValue, maxValue, idleValue } = req.body
    const bar = await QuickInsightBar.findOne({ _id: barId, managerId })
    if (!bar) throw createError(404, 'Bar not found')
    if (tagId) bar.tagId = tagId
    if (color) bar.color = color
    if (minValue !== undefined) bar.minValue = Number(minValue)
    if (maxValue !== undefined) bar.maxValue = Number(maxValue)
    if (idleValue !== undefined) bar.idleValue = Number(idleValue)
    await bar.save()
    res.json({ success: true, bar })
  } catch (error) { next(error) }
})

router.delete('/quick-insights/:barId', async (req, res, next) => {
  try {
    const managerId = req.user._id; const { barId } = req.params
    const bar = await QuickInsightBar.findOneAndDelete({ _id: barId, managerId })
    if (!bar) throw createError(404, 'Bar not found')
    res.json({ success: true })
  } catch (error) { next(error) }
})

// ─── QUICK INSIGHTS v2 — TAB-BASED DASHBOARD BUILDER ───────────────────────

// Validate employee belongs to manager
async function validateManagerEmployee(managerId, companyId, employeeId) {
  const employee = await User.findOne({ _id: employeeId, companyId, role: 'employee' }).lean()
  if (!employee) throw createError(404, 'Employee not found or not under your management')
  return employee
}

// LIST tabs for an employee
router.get('/quick-insights/employee/:employeeId/tabs', async (req, res, next) => {
  try {
    const managerId = req.user._id
    const companyId = req.user.companyId
    const { employeeId } = req.params
    await validateManagerEmployee(managerId, companyId, employeeId)

    const tabs = await QuickInsightTab.find({ companyId, managerId, employeeId })
      .sort({ order: 1, createdAt: 1 })
      .lean()

    const tabIds = tabs.map(t => t._id)
    const widgetCounts = await QuickInsightWidget.aggregate([
      { $match: { tabId: { $in: tabIds } } },
      { $group: { _id: '$tabId', count: { $sum: 1 } } }
    ])
    const countMap = {}
    widgetCounts.forEach(w => { countMap[w._id.toString()] = w.count })

    const result = tabs.map(tab => ({
      _id: tab._id.toString(),
      name: tab.name,
      order: tab.order,
      widgetCount: countMap[tab._id.toString()] || 0,
      createdAt: tab.createdAt
    }))

    res.json({ success: true, tabs: result })
  } catch (error) { next(error) }
})

// CREATE tab for an employee
router.post('/quick-insights/employee/:employeeId/tabs', async (req, res, next) => {
  try {
    const managerId = req.user._id
    const companyId = req.user.companyId
    const { employeeId } = req.params
    const { name } = req.body

    if (!name || !name.trim()) throw createError(400, 'Tab name is required')
    await validateManagerEmployee(managerId, companyId, employeeId)

    const existing = await QuickInsightTab.findOne({
      companyId, managerId, employeeId,
      name: { $regex: new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    }).lean()
    if (existing) throw createError(400, `A tab named "${name.trim()}" already exists`)

    const last = await QuickInsightTab.findOne({ companyId, managerId, employeeId }).sort({ order: -1 }).lean()
    const order = last ? last.order + 1 : 0

    const tab = await QuickInsightTab.create({
      companyId, managerId, employeeId,
      name: name.trim(),
      order
    })

    res.json({ success: true, tab: { _id: tab._id.toString(), name: tab.name, order: tab.order, widgetCount: 0 } })
  } catch (error) { next(error) }
})

// UPDATE tab (rename or reorder)
router.put('/quick-insights/tabs/:tabId', async (req, res, next) => {
  try {
    const managerId = req.user._id
    const { tabId } = req.params
    const { name, order } = req.body

    const tab = await QuickInsightTab.findOne({ _id: tabId, managerId })
    if (!tab) throw createError(404, 'Tab not found')

    if (name !== undefined) {
      const trimmed = (name || '').trim()
      if (!trimmed) throw createError(400, 'Tab name cannot be empty')

      const existing = await QuickInsightTab.findOne({
        _id: { $ne: tab._id },
        companyId: tab.companyId,
        managerId,
        employeeId: tab.employeeId,
        name: { $regex: new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
      }).lean()
      if (existing) throw createError(400, `A tab named "${trimmed}" already exists`)

      tab.name = trimmed
    }
    if (order !== undefined) tab.order = Number(order)
    await tab.save()

    res.json({ success: true, tab: { _id: tab._id.toString(), name: tab.name, order: tab.order } })
  } catch (error) { next(error) }
})

// DELETE tab + cascade widgets
router.delete('/quick-insights/tabs/:tabId', async (req, res, next) => {
  try {
    const managerId = req.user._id
    const { tabId } = req.params

    const tab = await QuickInsightTab.findOne({ _id: tabId, managerId })
    if (!tab) throw createError(404, 'Tab not found')

    await QuickInsightWidget.deleteMany({ tabId: tab._id })
    await QuickInsightTab.deleteOne({ _id: tabId })

    res.json({ success: true })
  } catch (error) { next(error) }
})

// LIST widgets for a tab
router.get('/quick-insights/tabs/:tabId/widgets', async (req, res, next) => {
  try {
    const managerId = req.user._id
    const { tabId } = req.params

    const tab = await QuickInsightTab.findOne({ _id: tabId, managerId }).lean()
    if (!tab) throw createError(404, 'Tab not found')

    const widgets = await QuickInsightWidget.find({ tabId }).sort({ createdAt: 1 }).lean()
    const result = await serializeQuickInsightWidgets(widgets)

    res.json({ success: true, widgets: result, tab: { _id: tab._id.toString(), name: tab.name, employeeId: tab.employeeId.toString() } })
  } catch (error) { next(error) }
})

// ADD widget to a tab
router.post('/quick-insights/tabs/:tabId/widgets', async (req, res, next) => {
  try {
    const managerId = req.user._id
    const companyId = req.user.companyId
    const { tabId } = req.params
    const { tagId, assetTwinInstanceId, type, visualizationId, w, h, meterMin, meterMax, meterIdle, meterColor } = req.body

    if (!type || !['meter', 'graph', 'assetTwin'].includes(type)) throw createError(400, 'Invalid widget type')

    const tab = await QuickInsightTab.findOne({ _id: tabId, managerId }).lean()
    if (!tab) throw createError(404, 'Tab not found')

    if (type === 'assetTwin') {
      if (!assetTwinInstanceId) throw createError(400, 'assetTwinInstanceId is required')
      const twin = await AssetTwinInstance.findOne({
        _id: assetTwinInstanceId,
        companyId,
        active: true
      }).lean()
      if (!twin) throw createError(400, 'Asset twin instance not found')
    } else {
      if (!tagId) throw createError(400, 'tagId is required')
      if (!visualizationId) throw createError(400, 'visualizationId is required')
      const validTag = await TelemetryTag.findOne({ _id: tagId, companyId }).lean()
      if (!validTag) {
        throw createError(400, 'Tag not found or belongs to another company')
      }
    }

    const existingWidgets = await QuickInsightWidget.find({ tabId }).sort({ y: -1, createdAt: -1 }).lean()
    let nextY = 0
    if (existingWidgets.length > 0) {
      const bottomWidget = existingWidgets.reduce((max, w) => {
        return (w.y + w.h) > (max.y + max.h) ? w : max
      }, existingWidgets[0])
      nextY = bottomWidget.y + bottomWidget.h
    }

    const widgetPayload = {
      tabId,
      type,
      x: 0,
      y: nextY,
      w: type === 'assetTwin' ? (w || 12) : (w || 3),
      h: type === 'assetTwin' ? (h || 6) : (h || 2),
      meterMin: meterMin !== undefined ? Number(meterMin) : null,
      meterMax: meterMax !== undefined ? Number(meterMax) : null,
      meterIdle: meterIdle !== undefined ? Number(meterIdle) : 0,
      meterColor: meterColor || '#22c55e'
    }

    if (type === 'assetTwin') {
      widgetPayload.assetTwinInstanceId = assetTwinInstanceId
      widgetPayload.visualizationId = visualizationId || 'MOTOR_2D_SIEMENS'
    } else {
      widgetPayload.tagId = tagId
      widgetPayload.visualizationId = visualizationId
    }

    const widget = await QuickInsightWidget.create(widgetPayload)
    const [serialized] = await serializeQuickInsightWidgets([widget.toObject()])

    res.json({ success: true, widget: serialized })
  } catch (error) { next(error) }
})

// UPDATE a single widget
router.put('/quick-insights/widgets/:widgetId', async (req, res, next) => {
  try {
    const managerId = req.user._id
    const { widgetId } = req.params
    const { x, y, w, h, visualizationId, meterMin, meterMax, meterIdle, meterColor } = req.body

    const widget = await QuickInsightWidget.findById(widgetId).populate('tabId')
    if (!widget) throw createError(404, 'Widget not found')
    if (widget.tabId.managerId.toString() !== managerId.toString()) throw createError(403, 'Forbidden')

    if (x !== undefined) widget.x = Number(x)
    if (y !== undefined) widget.y = Number(y)
    if (w !== undefined) widget.w = Number(w)
    if (h !== undefined) widget.h = Number(h)
    if (visualizationId) widget.visualizationId = visualizationId
    if (meterMin !== undefined) widget.meterMin = Number(meterMin)
    if (meterMax !== undefined) widget.meterMax = Number(meterMax)
    if (meterIdle !== undefined) widget.meterIdle = Number(meterIdle)
    if (meterColor !== undefined) widget.meterColor = meterColor
    await widget.save()

    res.json({
      success: true,
      widget: {
        _id: widget._id.toString(),
        x: widget.x, y: widget.y, w: widget.w, h: widget.h,
        visualizationId: widget.visualizationId,
        meterMin: widget.meterMin, meterMax: widget.meterMax,
        meterIdle: widget.meterIdle, meterColor: widget.meterColor
      }
    })
  } catch (error) { next(error) }
})

// DELETE a widget
router.delete('/quick-insights/widgets/:widgetId', async (req, res, next) => {
  try {
    const managerId = req.user._id
    const { widgetId } = req.params

    const widget = await QuickInsightWidget.findById(widgetId).populate('tabId')
    if (!widget) throw createError(404, 'Widget not found')
    if (widget.tabId.managerId.toString() !== managerId.toString()) throw createError(403, 'Forbidden')

    await QuickInsightWidget.deleteOne({ _id: widgetId })
    res.json({ success: true })
  } catch (error) { next(error) }
})

// BATCH update layout positions
router.put('/quick-insights/tabs/:tabId/widgets/layout', async (req, res, next) => {
  try {
    const managerId = req.user._id
    const { tabId } = req.params
    const { widgets } = req.body

    if (!Array.isArray(widgets)) throw createError(400, 'widgets array is required')

    const tab = await QuickInsightTab.findOne({ _id: tabId, managerId }).lean()
    if (!tab) throw createError(404, 'Tab not found')

    const bulkOps = widgets.map(w => ({
      updateOne: {
        filter: { _id: w.widgetId, tabId },
        update: { $set: { x: w.x, y: w.y, w: w.w, h: w.h } }
      }
    }))

    if (bulkOps.length > 0) {
      await QuickInsightWidget.bulkWrite(bulkOps)
    }

    res.json({ success: true })
  } catch (error) { next(error) }
})

router.use('/asset-twins', require('./managerAssetTwins'))

module.exports = router
