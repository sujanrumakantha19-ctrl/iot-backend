const createError = require('http-errors')
const mongoose = require('mongoose')
const TelemetryTag = require('../models/TelemetryTag')
const User = require('../models/User')
const CompanyAssetTwinAccess = require('../models/CompanyAssetTwinAccess')
const QuickInsightWidget = require('../models/QuickInsightWidget')
const { getTemplate, getTemplateSlotKeys } = require('../constants/assetTwinTemplates')

const TAG_PROJECTION = 'topicName parameterName displayName deviceName telemetryTopic unit gatewayId latestValue latestValueStr latestArrivedAt warningThreshold criticalThreshold decimal'

async function assertCompanyTemplateEnabled(companyId, templateId) {
  const access = await CompanyAssetTwinAccess.findOne({
    companyId,
    templateId,
    enabled: true
  }).lean()
  if (!access) {
    throw createError(403, 'Asset digital twin template is not enabled for this company')
  }
}

async function validateTagBindings(companyId, tagBindings = {}, templateId) {
  const template = getTemplate(templateId)
  if (!template) throw createError(400, 'Invalid template')

  const slotKeys = getTemplateSlotKeys(templateId)
  const usedTagIds = new Set()
  const normalized = {}

  for (const slotKey of slotKeys) {
    const slotDef = template.slots.find(s => s.key === slotKey)
    const rawId = tagBindings[slotKey]
    if (!rawId) {
      if (slotDef?.required) {
        throw createError(400, `Tag binding required for slot: ${slotDef.label}`)
      }
      normalized[slotKey] = null
      continue
    }
    if (!mongoose.Types.ObjectId.isValid(rawId)) {
      throw createError(400, `Invalid tag id for slot: ${slotKey}`)
    }
    const tagIdStr = rawId.toString()
    if (usedTagIds.has(tagIdStr)) {
      throw createError(400, 'Each tag can only be mapped to one slot')
    }
    usedTagIds.add(tagIdStr)
    normalized[slotKey] = rawId
  }

  const tagIds = [...usedTagIds]
  if (tagIds.length === 0) {
    throw createError(400, 'At least one tag binding is required')
  }

  const tags = await TelemetryTag.find({
    _id: { $in: tagIds },
    companyId
  }, TAG_PROJECTION).lean()

  if (tags.length !== tagIds.length) {
    throw createError(400, 'One or more tags not found or belong to another company')
  }

  return { normalized, tags }
}

async function assertManagerOwnsEmployees(managerId, companyId, employeeIds = []) {
  if (!Array.isArray(employeeIds)) {
    throw createError(400, 'assignedEmployeeIds must be an array')
  }
  if (employeeIds.length === 0) return

  const validEmployees = await User.find({
    _id: { $in: employeeIds },
    companyId,
    role: 'employee'
  }, '_id').lean()

  if (validEmployees.length !== employeeIds.length) {
    throw createError(400, 'One or more employees are invalid for this company')
  }
}

async function populateTwinWithTags(instance) {
  const plain = instance.toObject ? instance.toObject() : { ...instance }
  const bindings = plain.tagBindings || {}
  const tagIds = Object.values(bindings).filter(Boolean)

  const tags = tagIds.length > 0
    ? await TelemetryTag.find({ _id: { $in: tagIds } }, TAG_PROJECTION).lean()
    : []
  const tagMap = {}
  tags.forEach(t => { tagMap[t._id.toString()] = t })

  const populatedBindings = {}
  const values = {}
  for (const [slotKey, tagId] of Object.entries(bindings)) {
    if (!tagId) {
      populatedBindings[slotKey] = null
      values[slotKey] = null
      continue
    }
    const tag = tagMap[tagId.toString()] || null
    populatedBindings[slotKey] = tag
      ? {
          _id: tag._id,
          topicName: tag.topicName,
          parameterName: tag.parameterName,
          displayName: tag.displayName || '',
          deviceName: tag.deviceName,
          unit: tag.unit || '',
          latestValue: tag.latestValue ?? null,
          latestValueStr: tag.latestValueStr ?? null,
          latestArrivedAt: tag.latestArrivedAt ?? null,
          warningThreshold: tag.warningThreshold ?? null,
          criticalThreshold: tag.criticalThreshold ?? null
        }
      : null
    values[slotKey] = tag?.latestValue ?? null
  }

  return {
    ...plain,
    tagBindings: populatedBindings,
    values
  }
}

async function deleteWidgetsReferencingTwin(instanceId) {
  await QuickInsightWidget.deleteMany({ assetTwinInstanceId: instanceId })
}

function serializeTwinForList(instance) {
  const plain = instance.toObject ? instance.toObject() : { ...instance }
  return {
    _id: plain._id.toString(),
    companyId: plain.companyId?.toString?.() || plain.companyId,
    name: plain.name,
    templateId: plain.templateId,
    gatewayId: plain.gatewayId?.toString?.() || plain.gatewayId || null,
    description: plain.description || '',
    assignedEmployeeIds: (plain.assignedEmployeeIds || []).map(id => id.toString()),
    active: plain.active !== false,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt
  }
}

async function serializeQuickInsightWidgets(widgets) {
  if (!widgets.length) return []

  const tagIds = [...new Set(
    widgets.filter(w => w.tagId).map(w => w.tagId.toString())
  )]
  const twinIds = [...new Set(
    widgets.filter(w => w.assetTwinInstanceId).map(w => w.assetTwinInstanceId.toString())
  )]

  const AssetTwinInstance = require('../models/AssetTwinInstance')

  const [tags, twins] = await Promise.all([
    tagIds.length
      ? TelemetryTag.find({ _id: { $in: tagIds } }, TAG_PROJECTION).lean()
      : [],
    twinIds.length
      ? AssetTwinInstance.find({ _id: { $in: twinIds } }).lean()
      : []
  ])

  const tagMap = {}
  tags.forEach(t => { tagMap[t._id.toString()] = t })

  const twinMap = {}
  for (const twin of twins) {
    twinMap[twin._id.toString()] = await populateTwinWithTags(twin)
  }

  // Purge any orphan widgets whose tag was deleted from db
  const orphanWidgetIds = widgets
    .filter(w => w.type !== 'assetTwin' && w.tagId && !tagMap[w.tagId.toString()])
    .map(w => w._id)
  if (orphanWidgetIds.length > 0) {
    QuickInsightWidget.deleteMany({ _id: { $in: orphanWidgetIds } }).catch(err => {
      console.error('[QuickInsightWidget] Failed to prune orphan widgets:', err.message)
    })
  }

  // Filter out orphan widgets so they never appear in UI
  const validWidgets = widgets.filter(w => {
    if (w.type === 'assetTwin') return true
    return w.tagId && tagMap[w.tagId.toString()]
  })

  return validWidgets.map(w => {
    const base = {
      _id: w._id.toString(),
      tabId: w.tabId.toString(),
      type: w.type,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
      meterMin: w.meterMin,
      meterMax: w.meterMax,
      meterIdle: w.meterIdle,
      meterColor: w.meterColor
    }

    if (w.type === 'assetTwin') {
      const twin = twinMap[w.assetTwinInstanceId?.toString()] || null
      return {
        ...base,
        assetTwinInstanceId: w.assetTwinInstanceId?.toString() || null,
        assetTwin: twin
          ? {
              _id: twin._id.toString(),
              name: twin.name,
              templateId: twin.templateId,
              tagBindings: twin.tagBindings,
              values: twin.values
            }
          : null
      }
    }

    const tag = tagMap[w.tagId?.toString()] || {}
    return {
      ...base,
      tagId: w.tagId?.toString() || null,
      visualizationId: w.visualizationId,
      tag: tag._id
        ? {
            _id: tag._id,
            topicName: tag.topicName,
            parameterName: tag.parameterName,
            displayName: tag.displayName || '',
            deviceName: tag.deviceName,
            unit: tag.unit || '',
            latestValue: tag.latestValue ?? null,
            latestValueStr: tag.latestValueStr ?? null,
            latestArrivedAt: tag.latestArrivedAt ?? null,
            warningThreshold: tag.warningThreshold != null ? tag.warningThreshold : null,
            criticalThreshold: tag.criticalThreshold != null ? tag.criticalThreshold : null,
            decimal: tag.decimal != null ? tag.decimal : null
          }
        : null
    }
  })
}

module.exports = {
  TAG_PROJECTION,
  assertCompanyTemplateEnabled,
  validateTagBindings,
  assertManagerOwnsEmployees,
  populateTwinWithTags,
  deleteWidgetsReferencingTwin,
  serializeTwinForList,
  serializeQuickInsightWidgets
}
