const router = require('express').Router()
const createError = require('http-errors')
const Company = require('../models/Company')
const CompanyAssetTwinAccess = require('../models/CompanyAssetTwinAccess')
const { ASSET_TWIN_TEMPLATES } = require('../constants/assetTwinTemplates')
const { logActivity } = require('../services/activityLogger')

router.get('/templates', async (req, res) => {
  const templates = Object.values(ASSET_TWIN_TEMPLATES).map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    slots: t.slots
  }))
  res.json({ success: true, templates })
})

router.get('/company-access', async (req, res, next) => {
  try {
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10))
    const search = (req.query.search || '').trim()
    const skip = (pageNum - 1) * limitNum

    const filter = {}
    if (search) {
      filter.name = { $regex: search, $options: 'i' }
    }

    const [companies, total] = await Promise.all([
      Company.find(filter, 'name createdAt updatedAt')
        .sort({ name: 1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Company.countDocuments(filter)
    ])

    const companyIds = companies.map(c => c._id)
    const accessRows = await CompanyAssetTwinAccess.find({
      companyId: { $in: companyIds },
      templateId: 'MOTOR_2D_SIEMENS'
    }).lean()
    const accessMap = {}
    accessRows.forEach(row => {
      accessMap[row.companyId.toString()] = row
    })

    const items = companies.map(company => {
      const access = accessMap[company._id.toString()]
      return {
        companyId: company._id.toString(),
        companyName: company.name,
        templateId: 'MOTOR_2D_SIEMENS',
        enabled: access?.enabled === true,
        updatedAt: access?.updatedAt || company.updatedAt
      }
    })

    res.json({ success: true, items, total, page: pageNum, limit: limitNum })
  } catch (error) {
    next(error)
  }
})

router.put('/company-access', async (req, res, next) => {
  try {
    const { companyId, templateId, enabled } = req.body
    if (!companyId) throw createError(400, 'companyId is required')
    if (!templateId) throw createError(400, 'templateId is required')
    if (!ASSET_TWIN_TEMPLATES[templateId]) throw createError(400, 'Invalid templateId')

    const company = await Company.findById(companyId, 'name').lean()
    if (!company) throw createError(404, 'Company not found')

    const access = await CompanyAssetTwinAccess.findOneAndUpdate(
      { companyId, templateId },
      {
        companyId,
        templateId,
        enabled: enabled !== false,
        enabledBy: req.user._id
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )

    await logActivity({
      user: req.user,
      action: enabled !== false ? 'Enabled asset twin template' : 'Disabled asset twin template',
      category: 'Asset Digital Twin',
      details: `${company.name} — ${templateId}`,
      metadata: { companyId, templateId, enabled: access.enabled },
      req
    })

    res.json({
      success: true,
      access: {
        companyId: access.companyId.toString(),
        templateId: access.templateId,
        enabled: access.enabled,
        updatedAt: access.updatedAt
      }
    })
  } catch (error) {
    next(error)
  }
})

module.exports = router
