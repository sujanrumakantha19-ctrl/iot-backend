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
const { serializeQuickInsightWidgets } = require('../services/assetTwinService')

// Helper: Ensure tag is assigned to employee
const verifyTagAssignment = (user, tagId) => {
  const assigned = user.assignedTagIds.map(id => id.toString())
  if (!assigned.includes(tagId.toString())) {
    throw createError(403, 'Forbidden: Tag not assigned to employee')
  }
}

const TAG_PROJECTION = 'topicName parameterName displayName deviceName telemetryTopic unit gatewayId latestValue latestValueStr decimal latestArrivedAt watchlistedBy todayMax yesterdayMax weekMax assignedGraphType assignedMeterType meterMin meterMax meterColor meterIdle warningThreshold criticalThreshold alertsEnabled'

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
  // None = 0 decimal places, TRUNCATE (not round). 76.98 → "76", NOT "77"
  return String(Math.trunc(num))
}

// Get employee dashboard tag summary
router.get('/dashboard', async (req, res, next) => {
  try {
    const cacheKey = `emp_dash:${req.user._id}`
    const cached = cache.get(cacheKey)
    if (cached) return res.json(cached)

    const employee = await User.findById(req.user._id).lean()
    if (!employee) throw createError(404, 'Employee not found')

    const limitNum = Math.min(parseInt(req.query.limit, 10) || 200, 500)
    const tags = await TelemetryTag.find(
      { _id: { $in: employee.assignedTagIds }, companyId: req.user.companyId },
      TAG_PROJECTION
    )
      .populate('gatewayId', 'name prefix status')
      .sort({ parameterName: 1 })
      .collation({ locale: 'en', numericOrdering: true })
      .limit(limitNum)
      .lean()

    if (tags.length === 0) {
      return res.json({ success: true, tags: [] })
    }

    const empIdStr = employee._id.toString()
    const tagSummaries = tags.map((tag) => {
      return {
        tagId: tag._id.toString(),
        parameterName: tag.parameterName,
        displayName: tag.displayName || '',
        deviceName: tag.deviceName,
        topicName: tag.topicName,
        telemetryTopic: tag.telemetryTopic,
        unit: tag.unit,
        decimal: tag.decimal ?? 'None',
        gateway: tag.gatewayId ? { id: tag.gatewayId._id, name: tag.gatewayId.name, prefix: tag.gatewayId.prefix, status: tag.gatewayId.status } : null,
        liveValue: formatTagLiveValue(tag.latestValue, tag.decimal),
        arrivedAt: tag.latestArrivedAt ?? null,
        todayMax: tag.todayMax ?? 0,
        yesterdayMax: tag.yesterdayMax ?? 0,
        weekMax: tag.weekMax ?? 0,
        isWatchlisted: (tag.watchlistedBy || []).map(id => id.toString()).includes(empIdStr),
        assignedGraphType: tag.assignedGraphType || null,
        assignedMeterType: tag.assignedMeterType || null,
        meterMin: tag.meterMin ?? null,
        meterMax: tag.meterMax ?? null,
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
    const { page, limit, search, gatewayId } = req.query
    const employee = await User.findById(req.user._id).lean()
    if (!employee) throw createError(404, 'Employee not found')

    let filter = { _id: { $in: employee.assignedTagIds } }

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
      .sort({ parameterName: 1 })
      .collation({ locale: 'en', numericOrdering: true })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean()

    if (tags.length === 0) {
      return res.json({ success: true, tags: [], total })
    }

    const empIdStr = employee._id.toString()
    const tagSummaries = tags.map((tag) => {
      return {
        _id: tag._id.toString(),
        tagId: tag._id.toString(),
        parameterName: tag.parameterName,
        displayName: tag.displayName || '',
        deviceName: tag.deviceName,
        topicName: tag.topicName,
        telemetryTopic: tag.telemetryTopic,
        unit: tag.unit,
        decimal: tag.decimal ?? 'None',
        gateway: tag.gatewayId ? { id: tag.gatewayId._id, name: tag.gatewayId.name, prefix: tag.gatewayId.prefix, status: tag.gatewayId.status } : null,
        liveValue: formatTagLiveValue(tag.latestValue, tag.decimal),
        arrivedAt: tag.latestArrivedAt ?? null,
        todayMax: tag.todayMax ?? 0,
        yesterdayMax: tag.yesterdayMax ?? 0,
        weekMax: tag.weekMax ?? 0,
        isWatchlisted: (tag.watchlistedBy || []).map(id => id.toString()).includes(empIdStr),
        assignedGraphType: tag.assignedGraphType || null,
        assignedMeterType: tag.assignedMeterType || null,
        meterMin: tag.meterMin ?? null,
        meterMax: tag.meterMax ?? null,
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

    // Verify ownership
    const employee = await User.findById(req.user._id)
    verifyTagAssignment(employee, tagId)

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

// Get watchlist
router.get('/watchlist', async (req, res, next) => {
  try {
    const employee = await User.findById(req.user._id).lean()
    if (!employee) throw createError(404, 'Employee not found')

    const tags = await TelemetryTag.find(
      { _id: { $in: employee.assignedTagIds }, watchlistedBy: employee._id },
      'topicName parameterName displayName deviceName telemetryTopic unit gatewayId latestValue latestArrivedAt'
    )
      .populate('gatewayId', 'name prefix')
      .lean()

    const watchlistSummaries = tags.map((tag) => ({
      tagId: tag._id.toString(),
      parameterName: tag.parameterName,
      displayName: tag.displayName || '',
      deviceName: tag.deviceName,
      topicName: tag.topicName,
      telemetryTopic: tag.telemetryTopic,
      unit: tag.unit,
      gateway: tag.gatewayId ? { id: tag.gatewayId._id, name: tag.gatewayId.name, prefix: tag.gatewayId.prefix } : null,
      liveValue: tag.latestValue ?? null,
      arrivedAt: tag.latestArrivedAt ?? null
    }))

    res.json({ success: true, watchlist: watchlistSummaries })
  } catch (error) {
    next(error)
  }
})

// Toggle watchlist
router.post('/watchlist/toggle', async (req, res, next) => {
  try {
    const { tagId } = req.body
    if (!tagId) throw createError(400, 'tagId is required')

    const employee = await User.findById(req.user._id)
    verifyTagAssignment(employee, tagId)

    const tag = await TelemetryTag.findById(tagId)
    if (!tag) throw createError(404, 'Tag not found')

    const index = tag.watchlistedBy.map(id => id.toString()).indexOf(employee._id.toString())
    let isWatchlisted = false

    if (index > -1) {
      tag.watchlistedBy.splice(index, 1)
    } else {
      tag.watchlistedBy.push(employee._id)
      isWatchlisted = true
    }

    await tag.save()
    res.json({ success: true, isWatchlisted })
  } catch (error) {
    next(error)
  }
})

// Get report data
router.get('/report', async (req, res, next) => {
  try {
    const { tagId, startDate, endDate } = req.query
    const employee = await User.findById(req.user._id)
    if (!employee) throw createError(404, 'Employee not found')

    let tagIds = []

    if (tagId && tagId !== 'all') {
      verifyTagAssignment(employee, tagId)
      tagIds.push(tagId)
    } else {
      tagIds = employee.assignedTagIds
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
        'parameterName topicName displayName deviceName unit decimal'
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
    const { filters, format } = req.body
    const exportFormat = format || filters?.format || 'csv'

    const reportLog = await ReportExport.create({
      companyId: req.user.companyId,
      employeeId: req.user._id,
      generatedBy: req.user._id,
      filters: filters || {},
      format: exportFormat
    })

    res.json({ success: true, reportLog })
  } catch (error) {
    next(error)
  }
})

// Backend-driven Report File Download (CSV / JSON) for Employee
router.get('/report/download', async (req, res, next) => {
  try {
    const { tagId, startDate, endDate, format } = req.query
    const employee = await User.findById(req.user._id)
    if (!employee) throw createError(404, 'Employee not found')
    const exportFormat = (format || 'csv').toLowerCase() === 'json' ? 'json' : 'csv'

    let tagIds = []

    if (tagId && tagId !== 'all') {
      verifyTagAssignment(employee, tagId)
      tagIds.push(tagId)
    } else {
      tagIds = employee.assignedTagIds || []
    }

    if (!tagIds || tagIds.length === 0) {
      throw createError(400, 'No telemetry tags assigned')
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
        'parameterName topicName displayName deviceName unit decimal'
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
      companyId: req.user.companyId,
      employeeId: req.user._id,
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

// Get employee dashboard summary counts
router.get('/dashboard-summary', async (req, res, next) => {
  try {
    const employee = await User.findById(req.user._id, 'assignedGatewayIds assignedTagIds').lean()
    if (!employee) throw createError(404, 'Employee not found')

    const totalGateways = employee.assignedGatewayIds ? employee.assignedGatewayIds.length : 0
    const activeTags = employee.assignedTagIds ? employee.assignedTagIds.length : 0

    const onlineGateways = await Gateway.countDocuments({
      _id: { $in: employee.assignedGatewayIds || [] },
      status: 'online'
    })

    res.json({
      success: true,
      summary: {
        totalGateways,
        onlineGateways,
        activeTags
      }
    })
  } catch (error) {
    next(error)
  }
})

// Get employee assigned gateways & devices/tag details
router.get('/devices', async (req, res, next) => {
  try {
    const employee = await User.findById(req.user._id, 'assignedGatewayIds assignedTagIds')
      .populate({
        path: 'assignedGatewayIds',
        model: 'Gateway',
        select: 'name prefix location status'
      })
      .lean()
    if (!employee) throw createError(404, 'Employee not found')

    const tags = await TelemetryTag.find(
      { _id: { $in: employee.assignedTagIds || [] } },
      'gatewayId topicName unit'
    ).lean()

    const devices = employee.assignedGatewayIds.map(gw => {
      return {
        _id: gw._id,
        name: gw.name,
        prefix: gw.prefix,
        location: gw.location,
        status: gw.status || 'online',
        tags: tags.filter(t => t.gatewayId.toString() === gw._id.toString()).map(t => ({
          id: t._id,
          name: t.topicName,
          unit: t.unit
        }))
      }
    })

    res.json({ success: true, devices })
  } catch (error) {
    next(error)
  }
})

// Get employee's assigned digital meters (where assignedMeterType is set)
router.get('/digital-meters', async (req, res, next) => {
  try {
    const { page, limit } = req.query
    const employee = await User.findById(req.user._id, 'assignedTagIds').lean()
    if (!employee) throw createError(404, 'Employee not found')

    const filter = {
      _id: { $in: employee.assignedTagIds || [] },
      assignedMeterType: { $ne: null }
    }

    const pageNum = parseInt(page, 10) || 1
    const limitNum = parseInt(limit, 10) || 10

    const total = await TelemetryTag.countDocuments(filter)
    const tags = await TelemetryTag.find(filter, TAG_PROJECTION)
      .populate('gatewayId', 'name prefix status')
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
      gateway: tag.gatewayId ? { id: tag.gatewayId._id, name: tag.gatewayId.name, prefix: tag.gatewayId.prefix } : null,
      decimal: tag.decimal ?? 'None',
      liveValue: formatTagLiveValue(tag.latestValue, tag.decimal),
      arrivedAt: tag.latestArrivedAt ?? null,
      assignedMeterType: tag.assignedMeterType,
      assignedGraphType: tag.assignedGraphType || null,
      meterMin: tag.meterMin ?? 0,
      meterMax: tag.meterMax ?? 100,
      meterIdle: tag.meterIdle ?? 0,
      meterColor: tag.meterColor || '#22c55e'
    }))

    res.json({ success: true, tags: mapped, total })
  } catch (error) {
    next(error)
  }
})

// GET quick insight bars assigned to this employee (v1 - legacy)
router.get('/quick-insights', async (req, res, next) => {
  try {
    const employeeId = req.user._id
    const companyId = req.user.companyId
    const assignedTags = await TelemetryTag.find(
      { companyId, assignedEmployeeIds: employeeId },
      '_id topicName parameterName displayName deviceName latestValue latestValueStr unit'
    ).lean()
    const assignedTagIds = assignedTags.map(t => t._id.toString())
    const tagMap = {}
    assignedTags.forEach(t => { tagMap[t._id.toString()] = t })
    const bars = await QuickInsightBar.find({ companyId, tagId: { $in: assignedTags.map(t => t._id) } })
      .sort({ order: 1, createdAt: 1 }).lean()
    const result = bars.map(bar => ({ ...bar, tag: tagMap[bar.tagId.toString()] || {} }))
    res.json({ success: true, bars: result })
  } catch (error) { next(error) }
})

// ─── QUICK INSIGHTS v2 — EMPLOYEE READ-ONLY TABS ───────────────────────────

// LIST tabs created for this employee
router.get('/quick-insights/tabs', async (req, res, next) => {
  try {
    const employeeId = req.user._id

    const tabs = await QuickInsightTab.find({ employeeId })
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

// GET widgets for a specific tab
router.get('/quick-insights/tabs/:tabId/widgets', async (req, res, next) => {
  try {
    const employeeId = req.user._id
    const { tabId } = req.params

    const tab = await QuickInsightTab.findOne({ _id: tabId, employeeId }).lean()
    if (!tab) throw createError(404, 'Tab not found')

    const widgets = await QuickInsightWidget.find({ tabId }).sort({ createdAt: 1 }).lean()
    const result = await serializeQuickInsightWidgets(widgets)

    res.json({ success: true, widgets: result, tab: { _id: tab._id.toString(), name: tab.name } })
  } catch (error) { next(error) }
})

router.use('/asset-twins', require('./employeeAssetTwins'))

module.exports = router
