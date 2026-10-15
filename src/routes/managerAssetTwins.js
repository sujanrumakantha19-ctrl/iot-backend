const router = require('express').Router()
const createError = require('http-errors')
const mongoose = require('mongoose')
const AssetTwinInstance = require('../models/AssetTwinInstance')
const CompanyAssetTwinAccess = require('../models/CompanyAssetTwinAccess')
const TelemetryTag = require('../models/TelemetryTag')
const Gateway = require('../models/Gateway')
const {
  TAG_PROJECTION,
  assertCompanyTemplateEnabled,
  validateTagBindings,
  assertManagerOwnsEmployees,
  populateTwinWithTags,
  deleteWidgetsReferencingTwin,
  serializeTwinForList
} = require('../services/assetTwinService')
const { logActivity } = require('../services/activityLogger')

router.get('/access-status', async (req, res, next) => {
  try {
    const companyId = req.user.companyId
    const access = await CompanyAssetTwinAccess.findOne({
      companyId,
      templateId: 'MOTOR_2D_SIEMENS',
      enabled: true
    }).lean()
    res.json({ success: true, enabled: !!access })
  } catch (error) {
    next(error)
  }
})

router.get('/tag-options', async (req, res, next) => {
  try {
    const companyId = req.user.companyId
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
    const search = (req.query.search || '').trim()
    const gatewayId = req.query.gatewayId
    const skip = (pageNum - 1) * limitNum

    const filter = { companyId }
    if (gatewayId && mongoose.Types.ObjectId.isValid(gatewayId)) {
      filter.gatewayId = gatewayId
    }
    if (search) {
      filter.$or = [
        { displayName: { $regex: search, $options: 'i' } },
        { parameterName: { $regex: search, $options: 'i' } },
        { topicName: { $regex: search, $options: 'i' } },
        { deviceName: { $regex: search, $options: 'i' } }
      ]
    }

    const [tags, total] = await Promise.all([
      TelemetryTag.find(filter, TAG_PROJECTION)
        .sort({ displayName: 1, parameterName: 1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      TelemetryTag.countDocuments(filter)
    ])

    res.json({
      success: true,
      tags: tags.map(t => ({
        _id: t._id.toString(),
        topicName: t.topicName,
        parameterName: t.parameterName,
        displayName: t.displayName || '',
        deviceName: t.deviceName,
        unit: t.unit || '',
        gatewayId: t.gatewayId?.toString?.() || t.gatewayId || null,
        latestValue: t.latestValue ?? null,
        latestValueStr: t.latestValueStr ?? null
      })),
      total,
      page: pageNum,
      limit: limitNum
    })
  } catch (error) {
    next(error)
  }
})

router.get('/', async (req, res, next) => {
  try {
    const companyId = req.user.companyId
    await assertCompanyTemplateEnabled(companyId, 'MOTOR_2D_SIEMENS')

    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10))
    const search = (req.query.search || '').trim()
    const gatewayId = req.query.gatewayId
    const skip = (pageNum - 1) * limitNum

    const filter = { companyId, active: true }
    if (gatewayId && mongoose.Types.ObjectId.isValid(gatewayId)) {
      filter.gatewayId = gatewayId
    }
    if (search) {
      filter.name = { $regex: search, $options: 'i' }
    }

    const [instances, total] = await Promise.all([
      AssetTwinInstance.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('gatewayId', 'name gatewayId')
        .lean(),
      AssetTwinInstance.countDocuments(filter)
    ])

    res.json({
      success: true,
      instances: instances.map(inst => ({
        ...serializeTwinForList(inst),
        gateway: inst.gatewayId
          ? { _id: inst.gatewayId._id.toString(), name: inst.gatewayId.name, gatewayId: inst.gatewayId.gatewayId }
          : null
      })),
      total,
      page: pageNum,
      limit: limitNum
    })
  } catch (error) {
    next(error)
  }
})

router.post('/', async (req, res, next) => {
  try {
    const companyId = req.user.companyId
    const { name, templateId, gatewayId, description, tagBindings, assignedEmployeeIds } = req.body

    if (!name?.trim()) throw createError(400, 'name is required')
    if (!templateId) throw createError(400, 'templateId is required')

    await assertCompanyTemplateEnabled(companyId, templateId)
    const { normalized } = await validateTagBindings(companyId, tagBindings, templateId)
    await assertManagerOwnsEmployees(req.user._id, companyId, assignedEmployeeIds || [])

    if (gatewayId) {
      const gateway = await Gateway.findOne({ _id: gatewayId, companyId }).lean()
      if (!gateway) throw createError(400, 'Gateway not found for this company')
    }

    const instance = await AssetTwinInstance.create({
      companyId,
      name: name.trim(),
      templateId,
      gatewayId: gatewayId || null,
      description: description || '',
      tagBindings: normalized,
      assignedEmployeeIds: assignedEmployeeIds || [],
      createdBy: req.user._id,
      updatedBy: req.user._id
    })

    const populated = await populateTwinWithTags(instance)

    await logActivity({
      user: req.user,
      action: 'Created asset twin instance',
      category: 'Asset Digital Twin',
      details: populated.name,
      metadata: { instanceId: instance._id, templateId },
      req
    })

    res.json({ success: true, instance: populated })
  } catch (error) {
    next(error)
  }
})

router.get('/:id', async (req, res, next) => {
  try {
    const companyId = req.user.companyId
    const instance = await AssetTwinInstance.findOne({ _id: req.params.id, companyId, active: true })
      .populate('gatewayId', 'name prefix')
    if (!instance) throw createError(404, 'Asset twin instance not found')

    const populated = await populateTwinWithTags(instance)
    const gateway = populated.gatewayId && typeof populated.gatewayId === 'object'
      ? {
          _id: populated.gatewayId._id?.toString?.() || populated.gatewayId._id,
          name: populated.gatewayId.name,
          prefix: populated.gatewayId.prefix
        }
      : null

    res.json({
      success: true,
      instance: {
        ...populated,
        gatewayId: gateway?._id || populated.gatewayId?.toString?.() || populated.gatewayId || null,
        gateway
      }
    })
  } catch (error) {
    next(error)
  }
})

router.put('/:id', async (req, res, next) => {
  try {
    const companyId = req.user.companyId
    const { name, gatewayId, description, tagBindings, templateId } = req.body

    const instance = await AssetTwinInstance.findOne({ _id: req.params.id, companyId, active: true })
    if (!instance) throw createError(404, 'Asset twin instance not found')

    if (name !== undefined) {
      if (!name?.trim()) throw createError(400, 'name cannot be empty')
      instance.name = name.trim()
    }
    if (description !== undefined) instance.description = description || ''
    if (gatewayId !== undefined) {
      if (gatewayId) {
        const gateway = await Gateway.findOne({ _id: gatewayId, companyId }).lean()
        if (!gateway) throw createError(400, 'Gateway not found for this company')
        instance.gatewayId = gatewayId
      } else {
        instance.gatewayId = null
      }
    }
    if (tagBindings !== undefined) {
      const tpl = templateId || instance.templateId
      const { normalized } = await validateTagBindings(companyId, tagBindings, tpl)
      instance.tagBindings = normalized
    }

    instance.updatedBy = req.user._id
    await instance.save()

    const populated = await populateTwinWithTags(instance)

    await logActivity({
      user: req.user,
      action: 'Updated asset twin instance',
      category: 'Asset Digital Twin',
      details: instance.name,
      metadata: { instanceId: instance._id },
      req
    })

    res.json({ success: true, instance: populated })
  } catch (error) {
    next(error)
  }
})

router.delete('/:id', async (req, res, next) => {
  try {
    const companyId = req.user.companyId
    const instance = await AssetTwinInstance.findOne({ _id: req.params.id, companyId, active: true })
    if (!instance) throw createError(404, 'Asset twin instance not found')

    await deleteWidgetsReferencingTwin(instance._id)
    await AssetTwinInstance.deleteOne({ _id: instance._id })

    await logActivity({
      user: req.user,
      action: 'Deleted asset twin instance',
      category: 'Asset Digital Twin',
      details: instance.name,
      metadata: { instanceId: instance._id },
      req
    })

    res.json({ success: true })
  } catch (error) {
    next(error)
  }
})

router.put('/:id/assign-employees', async (req, res, next) => {
  try {
    const companyId = req.user.companyId
    const { assignedEmployeeIds } = req.body

    const instance = await AssetTwinInstance.findOne({ _id: req.params.id, companyId, active: true })
    if (!instance) throw createError(404, 'Asset twin instance not found')

    await assertManagerOwnsEmployees(req.user._id, companyId, assignedEmployeeIds || [])
    instance.assignedEmployeeIds = assignedEmployeeIds || []
    instance.updatedBy = req.user._id
    await instance.save()

    await logActivity({
      user: req.user,
      action: 'Assigned employees to asset twin',
      category: 'Asset Digital Twin',
      details: instance.name,
      metadata: { instanceId: instance._id, assignedEmployeeIds },
      req
    })

    res.json({
      success: true,
      instance: {
        _id: instance._id.toString(),
        assignedEmployeeIds: instance.assignedEmployeeIds.map(id => id.toString())
      }
    })
  } catch (error) {
    next(error)
  }
})

module.exports = router
