const router = require('express').Router()
const createError = require('http-errors')
const AssetTwinInstance = require('../models/AssetTwinInstance')
const { populateTwinWithTags, serializeTwinForList } = require('../services/assetTwinService')

router.get('/', async (req, res, next) => {
  try {
    const employeeId = req.user._id
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10))
    const search = (req.query.search || '').trim()
    const skip = (pageNum - 1) * limitNum

    const filter = {
      active: true,
      assignedEmployeeIds: employeeId
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

router.get('/:id', async (req, res, next) => {
  try {
    const employeeId = req.user._id
    const instance = await AssetTwinInstance.findOne({
      _id: req.params.id,
      active: true,
      assignedEmployeeIds: employeeId
    })
    if (!instance) throw createError(403, 'Asset twin not found or not assigned to you')

    const populated = await populateTwinWithTags(instance)
    res.json({ success: true, instance: populated })
  } catch (error) {
    next(error)
  }
})

module.exports = router
