const router = require('express').Router()
const bcrypt = require('bcryptjs')
const createError = require('http-errors')
const Company = require('../models/Company')
const User = require('../models/User')
const Gateway = require('../models/Gateway')
const TelemetryTag = require('../models/TelemetryTag')
const TelemetryReading = require('../models/TelemetryReading')
const GatewayConfig = require('../models/GatewayConfig')
const AppSetting = require('../models/AppSetting')
const backupSync = require('../services/backupSync')
const emailService = require('../services/emailService')
const cache = require('../services/cache')
const influx = require('../services/influx')
const { logActivity } = require('../services/activityLogger')
const { cleanupGatewayCascade } = require('../services/gatewayCleanup')
const {
  resolveExistingAssignedTagIds,
  clearTagAssignmentsForGateway,
  reconcileCompanyGatewayTags,
  filterTagsToActiveConfigs,
  countExistingAssignedTags
} = require('../services/tagSync')

const slugify = (text) => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-') // replace spaces with hyphens
    .replace(/[^a-z0-9_-]+/g, '') // remove non-alphanumeric except hyphen/underscore
    .replace(/\-+/g, '-') // remove double hyphens
}

// ----------------------------------------------------
// COMPANIES CRUD & DETAIL
// ----------------------------------------------------
router.get('/companies', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 1000))
    const { search } = req.query
    const filter = search
      ? { name: { $regex: search, $options: 'i' } }
      : {}
    const total = await Company.countDocuments(filter)
    const list = await Company.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
    res.json({ success: true, companies: list, total, page, limit })
  } catch (error) {
    next(error)
  }
})

router.post('/companies', async (req, res, next) => {
  try {
    const { name, description } = req.body
    if (!name) throw createError(400, 'Company Name is required')

    const slug = slugify(name)
    const existing = await Company.findOne({ slug })
    if (existing) throw createError(400, 'Company name already exists (duplicate slug)')

    const company = await Company.create({ name, slug, description })

    logActivity({
      user: req.user,
      companyId: company._id,
      companyName: company.name,
      action: 'CREATE_COMPANY',
      category: 'Company',
      details: `Company "${company.name}" registered`,
      req
    })

    if (req.app.locals.mqttClient && typeof req.app.locals.mqttClient.subscribeToCompanyTelemetry === 'function') {
      req.app.locals.mqttClient.subscribeToCompanyTelemetry(company.slug)
    }

    res.json({ success: true, company })
  } catch (error) {
    next(error)
  }
})

router.put('/companies/:id', async (req, res, next) => {
  try {
    const { name, description } = req.body
    const updateData = { description }

    if (name) {
      updateData.name = name
      updateData.slug = slugify(name)
      const existing = await Company.findOne({ slug: updateData.slug, _id: { $ne: req.params.id } })
      if (existing) throw createError(400, 'Company name already exists (duplicate slug)')
    }

    const oldCompany = await Company.findById(req.params.id)
    if (!oldCompany) throw createError(404, 'Company not found')

    const company = await Company.findByIdAndUpdate(req.params.id, updateData, { new: true })
    if (!company) throw createError(404, 'Company not found')

    logActivity({
      user: req.user,
      companyId: company._id,
      companyName: company.name,
      action: 'UPDATE_COMPANY',
      category: 'Company',
      details: `Company "${company.name}" settings updated`,
      req
    })

    if (name && company.slug !== oldCompany.slug) {
      if (req.app.locals.mqttClient && typeof req.app.locals.mqttClient.subscribeToCompanyTelemetry === 'function') {
        req.app.locals.mqttClient.subscribeToCompanyTelemetry(company.slug)
        if (typeof req.app.locals.mqttClient.unsubscribeFromCompanyTelemetry === 'function') {
          req.app.locals.mqttClient.unsubscribeFromCompanyTelemetry(oldCompany.slug)
        }
      }
    }

    res.json({ success: true, company })
  } catch (error) {
    next(error)
  }
})

router.delete('/companies/:id', async (req, res, next) => {
  try {
    const company = await Company.findByIdAndDelete(req.params.id)
    if (!company) throw createError(404, 'Company not found')

    logActivity({
      user: req.user,
      companyId: company._id,
      companyName: company.name,
      action: 'DELETE_COMPANY',
      category: 'Company',
      details: `Company "${company.name}" deleted along with associated users and gateways`,
      req
    })

    // Clean up managers, employees, and gateways under this company
    await User.deleteMany({ companyId: req.params.id })
    await Gateway.deleteMany({ companyId: req.params.id })
    await TelemetryTag.deleteMany({ companyId: req.params.id })
    await TelemetryReading.deleteMany({ companyId: req.params.id })
    await GatewayConfig.deleteMany({ companyId: req.params.id })

    res.json({ success: true, message: 'Company deleted along with all its users, gateways, and configurations' })
  } catch (error) {
    next(error)
  }
})

router.get('/companies/:id/detail', async (req, res, next) => {
  try {
    const company = await Company.findById(req.params.id)
    if (!company) throw createError(404, 'Company not found')

    // Pagination query params for each section — default 6 per page
    const mPage = Math.max(1, parseInt(req.query.managersPage, 10) || 1)
    const mLimit = Math.min(100, Math.max(1, parseInt(req.query.managersLimit, 10) || 6))
    const ePage = Math.max(1, parseInt(req.query.employeesPage, 10) || 1)
    const eLimit = Math.min(100, Math.max(1, parseInt(req.query.employeesLimit, 10) || 6))
    const gPage = Math.max(1, parseInt(req.query.gatewaysPage, 10) || 1)
    const gLimit = Math.min(100, Math.max(1, parseInt(req.query.gatewaysLimit, 10) || 6))

    const baseFilter = { companyId: req.params.id }

    const [managersTotal, employeesTotal, gatewaysTotal] = await Promise.all([
      User.countDocuments({ ...baseFilter, role: 'manager' }),
      User.countDocuments({ ...baseFilter, role: 'employee' }),
      Gateway.countDocuments(baseFilter)
    ])

    const [managers, employees, gateways] = await Promise.all([
      User.find({ ...baseFilter, role: 'manager' })
        .select('-passwordHash -profilePhoto')
        .skip((mPage - 1) * mLimit)
        .limit(mLimit),
      User.find({ ...baseFilter, role: 'employee' })
        .select('-passwordHash -profilePhoto')
        .skip((ePage - 1) * eLimit)
        .limit(eLimit),
      Gateway.find(baseFilter)
        .skip((gPage - 1) * gLimit)
        .limit(gLimit)
    ])

    res.json({
      success: true,
      company,
      managers,
      employees,
      gateways,
      counts: {
        managers: managersTotal,
        employees: employeesTotal,
        gateways: gatewaysTotal
      }
    })
  } catch (error) {
    next(error)
  }
})

// ----------------------------------------------------
// MANAGERS CRUD
// ----------------------------------------------------
router.get('/managers', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10))
    const filter = { role: 'manager' }
    if (req.query.companyId) filter.companyId = req.query.companyId
    if (req.query.search) {
      filter.$or = [
        { name: { $regex: req.query.search, $options: 'i' } },
        { email: { $regex: req.query.search, $options: 'i' } }
      ]
    }

    const total = await User.countDocuments(filter)
    const list = await User.find(filter)
      .select('-passwordHash -profilePhoto')
      .populate('companyId', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()

    res.json({ success: true, managers: list, total, page, limit })
  } catch (error) {
    next(error)
  }
})

router.post('/managers', async (req, res, next) => {
  try {
    const { name, email, password, companyId, assignPermissionMode, allowedGraphIds, allowedMeterTypes, featurePermissions } = req.body
    if (!name || !email || !password || !companyId) {
      throw createError(400, 'Name, email, password, and company are required')
    }

    const existing = await User.findOne({ email })
    if (existing) throw createError(400, 'Email already registered')

    const salt = await bcrypt.genSalt(10)
    const passwordHash = await bcrypt.hash(password, salt)

    const manager = await User.create({
      name,
      email,
      passwordHash,
      role: 'manager',
      companyId,
      assignPermissionMode: assignPermissionMode || 'all',
      allowedGraphIds: allowedGraphIds || [],
      allowedMeterTypes: allowedMeterTypes || [],
      featurePermissions: featurePermissions || {
        showUsers: false,
        showGateway: false,
        gatewayFeatures: {
          showDeviceList: false,
          showPublish: false,
          showReadConfig: false,
          showWifi: false,
          showLocation: false,
          showPublishInterval: false
        }
      },
      active: true
    })

    logActivity({
      user: req.user,
      companyId: manager.companyId,
      action: 'CREATE_MANAGER',
      category: 'User',
      details: `Manager "${manager.name}" (${manager.email}) created`,
      req
    })

    res.json({ success: true, manager })
  } catch (error) {
    next(error)
  }
})

router.put('/managers/:id', async (req, res, next) => {
  try {
    const { name, email, password, companyId, active, assignPermissionMode, allowedGraphIds, allowedMeterTypes, featurePermissions } = req.body
    const updateData = {}

    if (name) updateData.name = name
    if (companyId) updateData.companyId = companyId
    if (active !== undefined) updateData.active = active
    if (assignPermissionMode !== undefined) updateData.assignPermissionMode = assignPermissionMode
    if (allowedGraphIds !== undefined) updateData.allowedGraphIds = allowedGraphIds || []
    if (allowedMeterTypes !== undefined) updateData.allowedMeterTypes = allowedMeterTypes || []
    if (featurePermissions !== undefined) updateData.featurePermissions = featurePermissions
    if (req.body.profilePhoto !== undefined) updateData.profilePhoto = req.body.profilePhoto

    if (email) {
      updateData.email = email
      const existing = await User.findOne({ email, _id: { $ne: req.params.id } })
      if (existing) throw createError(400, 'Email already registered')
    }

    if (password) {
      const salt = await bcrypt.genSalt(10)
      updateData.passwordHash = await bcrypt.hash(password, salt)
    }

    const manager = await User.findByIdAndUpdate(req.params.id, updateData, { new: true }).select('-passwordHash')
    if (!manager) throw createError(404, 'Manager not found')

    logActivity({
      user: req.user,
      companyId: manager.companyId,
      action: 'UPDATE_MANAGER',
      category: 'User',
      details: `Manager "${manager.name}" (${manager.email}) settings updated`,
      req
    })

    res.json({ success: true, manager })
  } catch (error) {
    next(error)
  }
})

router.delete('/managers/:id', async (req, res, next) => {
  try {
    const manager = await User.findOneAndDelete({ _id: req.params.id, role: 'manager' })
    if (!manager) throw createError(404, 'Manager not found')

    logActivity({
      user: req.user,
      companyId: manager.companyId,
      action: 'DELETE_MANAGER',
      category: 'User',
      details: `Manager "${manager.name}" (${manager.email}) deleted`,
      req
    })

    // Disassociate employees from this manager
    await User.updateMany({ managerId: req.params.id }, { $pull: { managerId: req.params.id } })

    res.json({ success: true, message: 'Manager deleted and employees unassigned' })
  } catch (error) {
    next(error)
  }
})

// ----------------------------------------------------
// EMPLOYEES CRUD
// ----------------------------------------------------
router.get('/employees', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10))
    const filter = { role: 'employee' }
    if (req.query.companyId) filter.companyId = req.query.companyId
    if (req.query.search) {
      filter.$or = [
        { name: { $regex: req.query.search, $options: 'i' } },
        { email: { $regex: req.query.search, $options: 'i' } }
      ]
    }

    const total = await User.countDocuments(filter)
    const list = await User.find(filter)
      .select('-passwordHash -profilePhoto')
      .populate('companyId', 'name')
      .populate('managerId', 'name')
      .populate('assignedGatewayIds', 'name prefix')
      .populate('assignedTagIds', 'topicName parameterName')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()

    res.json({ success: true, employees: list, total, page, limit })
  } catch (error) {
    next(error)
  }
})

router.post('/employees', async (req, res, next) => {
  try {
    const { name, email, password, companyId, managerId, assignedGatewayIds, assignedTagIds, addressLabel, address } = req.body
    if (!name || !email || !password || !companyId || !addressLabel || !address || !addressLabel.trim() || !address.trim()) {
      throw createError(400, 'Name, email, password, company, address label, and address are required')
    }

    const existing = await User.findOne({ email })
    if (existing) throw createError(400, 'Email already registered')

    const salt = await bcrypt.genSalt(10)
    const passwordHash = await bcrypt.hash(password, salt)

    const employee = await User.create({
      name,
      email,
      passwordHash,
      role: 'employee',
      companyId,
      managerId: managerId || [],
      assignedGatewayIds: assignedGatewayIds || [],
      assignedTagIds: assignedTagIds || [],
      addressLabel: addressLabel.trim(),
      address: address.trim(),
      active: true
    })

    // Update TelemetryTag assigned employee lists
    if (assignedTagIds && assignedTagIds.length > 0) {
      await TelemetryTag.updateMany(
        { _id: { $in: assignedTagIds } },
        { $addToSet: { assignedEmployeeIds: employee._id } }
      )

      // Auto-derive and save assignedGatewayIds from the assigned tags
      const allAssignedTags = await TelemetryTag.find({ _id: { $in: assignedTagIds } }).select('gatewayId')
      const uniqueGwIds = [...new Set(
        allAssignedTags.map(t => t.gatewayId?.toString()).filter(Boolean)
      )]
      await User.findByIdAndUpdate(employee._id, { assignedGatewayIds: uniqueGwIds })
    }

    logActivity({
      user: req.user,
      companyId: employee.companyId,
      action: 'CREATE_EMPLOYEE',
      category: 'User',
      details: `User/Employee "${employee.name}" (${employee.email}) registered`,
      req
    })

    res.json({ success: true, employee })
  } catch (error) {
    next(error)
  }
})

router.put('/employees/:id', async (req, res, next) => {
  try {
    const { name, email, password, companyId, managerId, assignedGatewayIds, assignedTagIds, active, addressLabel, address } = req.body
    const updateData = {}

    if (name) updateData.name = name
    if (companyId) updateData.companyId = companyId
    if (managerId !== undefined) updateData.managerId = managerId || []
    if (assignedGatewayIds !== undefined) updateData.assignedGatewayIds = assignedGatewayIds || []
    if (active !== undefined) updateData.active = active
    if (addressLabel !== undefined) {
      if (!addressLabel.trim()) throw createError(400, 'Address Label is required')
      updateData.addressLabel = addressLabel.trim()
    }
    if (address !== undefined) {
      if (!address.trim()) throw createError(400, 'Address is required')
      updateData.address = address.trim()
    }
    if (req.body.profilePhoto !== undefined) updateData.profilePhoto = req.body.profilePhoto

    if (email) {
      updateData.email = email
      const existing = await User.findOne({ email, _id: { $ne: req.params.id } })
      if (existing) throw createError(400, 'Email already registered')
    }

    if (password) {
      const salt = await bcrypt.genSalt(10)
      updateData.passwordHash = await bcrypt.hash(password, salt)
    }

    // Get the employee before updates to check tag assignments diff
    const prevEmployee = await User.findById(req.params.id)
    if (!prevEmployee) throw createError(404, 'Employee not found')

    let validTagIds = null
    if (assignedTagIds !== undefined) {
      validTagIds = await resolveExistingAssignedTagIds(assignedTagIds || [])
      updateData.assignedTagIds = validTagIds
    }

    const employee = await User.findByIdAndUpdate(req.params.id, updateData, { new: true }).select('-passwordHash')

    logActivity({
      user: req.user,
      companyId: employee.companyId,
      action: 'UPDATE_EMPLOYEE',
      category: 'User',
      details: `User/Employee "${employee.name}" (${employee.email}) details updated`,
      req
    })

    // Handle TelemetryTag assignments updates
    if (validTagIds !== null) {
      const prevTags = (prevEmployee.assignedTagIds || []).map(t => t.toString())
      const newTags = validTagIds.map(t => t.toString())

      const removed = prevTags.filter(t => !newTags.includes(t))
      const added = newTags.filter(t => !prevTags.includes(t))

      if (removed.length > 0) {
        await TelemetryTag.updateMany(
          { _id: { $in: removed } },
          { $pull: { assignedEmployeeIds: employee._id } }
        )
      }
      if (added.length > 0) {
        await TelemetryTag.updateMany(
          { _id: { $in: added } },
          { $addToSet: { assignedEmployeeIds: employee._id } }
        )
      }

      // Auto-derive assignedGatewayIds from the gatewayId of all assigned tags
      const allAssignedTags = await TelemetryTag.find({ _id: { $in: validTagIds } }).select('gatewayId')
      const uniqueGwIds = [...new Set(
        allAssignedTags.map(t => t.gatewayId?.toString()).filter(Boolean)
      )]
      await User.findByIdAndUpdate(req.params.id, { assignedGatewayIds: uniqueGwIds })

      // Invalidate dashboard caches so employee/manager dashboards show fresh counts
      cache.invalidate(`emp_dash:${req.params.id}`)
      cache.invalidate(`mgr_dash:${prevEmployee.companyId}`)
    }

    res.json({ success: true, employee })
  } catch (error) {
    next(error)
  }
})

router.delete('/employees/:id', async (req, res, next) => {
  try {
    const employee = await User.findOneAndDelete({ _id: req.params.id, role: 'employee' })
    if (!employee) throw createError(404, 'Employee not found')

    logActivity({
      user: req.user,
      companyId: employee.companyId,
      action: 'DELETE_EMPLOYEE',
      category: 'User',
      details: `User/Employee "${employee.name}" (${employee.email}) deleted`,
      req
    })

    // Clean up tag assignments
    await TelemetryTag.updateMany(
      { assignedEmployeeIds: req.params.id },
      { $pull: { assignedEmployeeIds: req.params.id } }
    )

    res.json({ success: true, message: 'Employee deleted and assignments cleaned up' })
  } catch (error) {
    next(error)
  }
})

// ----------------------------------------------------
// GATEWAYS CRUD
// ----------------------------------------------------
router.get('/gateways', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10))
    const filter = {}
    if (req.query.companyId) filter.companyId = req.query.companyId
    if (req.query.search) {
      filter.$or = [
        { name: { $regex: req.query.search, $options: 'i' } },
        { prefix: { $regex: req.query.search, $options: 'i' } },
        { location: { $regex: req.query.search, $options: 'i' } }
      ]
    }

    const total = await Gateway.countDocuments(filter)
    const list = await Gateway.find(filter)
      .populate('companyId', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()

    res.json({ success: true, gateways: list, total, page, limit })
  } catch (error) {
    next(error)
  }
})

router.post('/gateways', async (req, res, next) => {
  try {
    const { companyId, name, prefix, location, maxParameters, maxGroups } = req.body
    if (!companyId || !name || !prefix) {
      throw createError(400, 'Company, name, and prefix are required')
    }

    // Prefix validation (unique, alphanumeric/hyphen/underscore)
    if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) {
      throw createError(400, 'Prefix must contain only letters, numbers, hyphens, and underscores')
    }

    const existing = await Gateway.findOne({ prefix })
    if (existing) throw createError(400, 'Gateway prefix already exists')

    let maxParamsNum = 1000
    if (maxParameters != null && maxParameters !== '') {
      const parsed = parseInt(maxParameters, 10)
      if (isNaN(parsed) || parsed < 1) {
        throw createError(400, 'Maximum allowed parameters must be at least 1')
      }
      maxParamsNum = Math.max(1, Math.min(5000, parsed))
    } else if (maxGroups != null && maxGroups !== '') {
      const parsedG = parseInt(maxGroups, 10)
      if (isNaN(parsedG) || parsedG < 1) {
        throw createError(400, 'Maximum allowed groups must be at least 1')
      }
      maxParamsNum = Math.max(1, Math.min(100, parsedG)) * 50
    }
    const maxGroupsNum = Math.ceil(maxParamsNum / 50)

    const gateway = await Gateway.create({
      companyId,
      name,
      prefix,
      location: location || '',
      maxParameters: maxParamsNum,
      maxGroups: maxGroupsNum,
      status: 'offline',
      createdAt: new Date()
    })

    logActivity({
      user: req.user,
      companyId: gateway.companyId,
      action: 'CREATE_GATEWAY',
      category: 'Gateway',
      details: `Hardware Gateway "${gateway.name}" (${gateway.prefix}) created with max ${gateway.maxParameters} parameters (${gateway.maxGroups} groups)`,
      req
    })

    if (req.app.locals.mqttClient && typeof req.app.locals.mqttClient.subscribeToGatewayTopics === 'function') {
      req.app.locals.mqttClient.subscribeToGatewayTopics(gateway.prefix)
    }

    res.json({ success: true, gateway })
  } catch (error) {
    next(error)
  }
})

router.put('/gateways/:id', async (req, res, next) => {
  try {
    const { name, prefix, location, companyId, maxParameters, maxGroups } = req.body
    const updateData = {}

    if (name) updateData.name = name
    if (location !== undefined) updateData.location = location
    if (maxParameters !== undefined && maxParameters !== null && maxParameters !== '') {
      const parsed = parseInt(maxParameters, 10)
      if (isNaN(parsed) || parsed < 1) {
        throw createError(400, 'Maximum allowed parameters must be at least 1')
      }
      const maxParamsNum = Math.max(1, Math.min(5000, parsed))
      updateData.maxParameters = maxParamsNum
      updateData.maxGroups = Math.ceil(maxParamsNum / 50)
    } else if (maxGroups !== undefined && maxGroups !== null && maxGroups !== '') {
      const parsedG = parseInt(maxGroups, 10)
      if (isNaN(parsedG) || parsedG < 1) {
        throw createError(400, 'Maximum allowed groups must be at least 1')
      }
      const maxGroupsNum = Math.max(1, Math.min(100, parsedG))
      updateData.maxGroups = maxGroupsNum
      updateData.maxParameters = maxGroupsNum * 50
    }

    if (prefix) {
      if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) {
        throw createError(400, 'Prefix must contain only letters, numbers, hyphens, and underscores')
      }
      const existing = await Gateway.findOne({ prefix, _id: { $ne: req.params.id } })
      if (existing) throw createError(400, 'Gateway prefix already exists')
      updateData.prefix = prefix
    }

    const oldGateway = await Gateway.findById(req.params.id)
    if (!oldGateway) throw createError(404, 'Gateway not found')

    let companyChanged = false
    if (companyId !== undefined && companyId !== null && companyId !== '') {
      const company = await Company.findById(companyId, 'name').lean()
      if (!company) throw createError(400, 'Company not found')
      if (oldGateway.companyId?.toString() !== companyId.toString()) {
        updateData.companyId = companyId
        companyChanged = true
      }
    }

    const gateway = await Gateway.findByIdAndUpdate(req.params.id, updateData, { new: true })
      .populate('companyId', 'name')
    if (!gateway) throw createError(404, 'Gateway not found')

    if (companyChanged) {
      await clearTagAssignmentsForGateway(gateway._id)
      await Promise.all([
        TelemetryTag.updateMany(
          { gatewayId: gateway._id },
          { $set: { companyId: gateway.companyId, assignedEmployeeIds: [] } }
        ),
        GatewayConfig.updateMany(
          { gatewayId: gateway._id },
          { $set: { companyId: gateway.companyId } }
        )
      ])
      cache.flush()
    }

    logActivity({
      user: req.user,
      companyId: gateway.companyId,
      action: 'UPDATE_GATEWAY',
      category: 'Gateway',
      details: companyChanged
        ? `Hardware Gateway "${gateway.name}" (${gateway.prefix}) moved to company ${gateway.companyId?.name || gateway.companyId}`
        : `Hardware Gateway "${gateway.name}" (${gateway.prefix}) updated`,
      req
    })

    if (prefix && prefix !== oldGateway.prefix) {
      if (req.app.locals.mqttClient && typeof req.app.locals.mqttClient.subscribeToGatewayTopics === 'function') {
        req.app.locals.mqttClient.subscribeToGatewayTopics(gateway.prefix)
        if (typeof req.app.locals.mqttClient.unsubscribeFromGatewayTopics === 'function') {
          req.app.locals.mqttClient.unsubscribeFromGatewayTopics(oldGateway.prefix)
        }
      }
    }

    res.json({ success: true, gateway })
  } catch (error) {
    next(error)
  }
})

router.delete('/gateways/:id', async (req, res, next) => {
  try {
    const gatewayId = req.params.id
    const gateway = await Gateway.findById(gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    logActivity({
      user: req.user,
      companyId: gateway.companyId,
      action: 'DELETE_GATEWAY',
      category: 'Gateway',
      details: `Hardware Gateway "${gateway.name}" (${gateway.prefix}) deleted by Admin`,
      req
    })

    await cleanupGatewayCascade(gatewayId, req.app.locals)

    res.json({ success: true, message: 'Gateway and all associated configurations, tags, and assignments deleted successfully' })
  } catch (error) {
    next(error)
  }
})

// Get telemetry tags for a gateway (paginated, with numerical collation and search)
router.get('/gateways/:gatewayId/tags', async (req, res, next) => {
  try {
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limitNum = Math.max(1, parseInt(req.query.limit, 10) || 10)
    const { search } = req.query

    const filter = { gatewayId: req.params.gatewayId }
    if (search) {
      const q = search.trim()
      filter.$or = [
        { parameterName: { $regex: q, $options: 'i' } },
        { deviceName: { $regex: q, $options: 'i' } },
        { displayName: { $regex: q, $options: 'i' } },
        { address: isNaN(q) ? undefined : parseInt(q, 10) }
      ].filter(Boolean)
    }

    const total = await TelemetryTag.countDocuments(filter)
    const tags = await TelemetryTag.find(filter)
      .sort({ parameterName: 1 })
      .collation({ locale: 'en', numericOrdering: true })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean()

    res.json({ success: true, tags, total })
  } catch (error) {
    next(error)
  }
})

// Bulk update display labels and units for a gateway's tags
router.put('/gateways/:gatewayId/labels', async (req, res, next) => {
  try {
    const { labels = {}, units = {} } = req.body
    const allTagIds = new Set([...Object.keys(labels || {}), ...Object.keys(units || {})])

    const updates = []
    for (const tagId of allTagIds) {
      const setFields = {}
      if (labels && labels[tagId] !== undefined) {
        setFields.displayName = (labels[tagId] || '').trim()
      }
      if (units && units[tagId] !== undefined) {
        setFields.unit = (units[tagId] || '').trim()
      }
      if (Object.keys(setFields).length > 0) {
        updates.push({
          updateOne: {
            filter: { _id: tagId, gatewayId: req.params.gatewayId },
            update: { $set: setFields }
          }
        })
      }
    }

    if (updates.length > 0) {
      await TelemetryTag.bulkWrite(updates)
    }

    res.json({ success: true, message: 'Labels and units updated successfully' })
  } catch (error) {
    next(error)
  }
})

router.get('/telemetry-tags', async (req, res, next) => {
  try {
    const list = await TelemetryTag.find({})
      .populate('companyId', 'name')
      .populate('gatewayId', 'name prefix status')
      .lean()
    res.json({ success: true, tags: list })
  } catch (error) {
    next(error)
  }
})

// ----------------------------------------------------
// BACKUP / EXPORT APIs
// ----------------------------------------------------

// Per-company storage distribution stats
router.get('/backup/storage-stats', async (req, res, next) => {
  try {
    const companies = await Company.find({}, 'name').lean()
    if (companies.length === 0) return res.json({ success: true, stats: [] })

    const [userStats, gatewayStats, tagStats, readingMap] = await Promise.all([
      User.aggregate([{ $group: { _id: '$companyId', count: { $sum: 1 } } }]),
      Gateway.aggregate([{ $group: { _id: '$companyId', count: { $sum: 1 } } }]),
      TelemetryTag.aggregate([{ $group: { _id: '$companyId', count: { $sum: 1 } } }]),
      influx.countByCompany()
    ])

    const toMap = (arr) => {
      const m = {}
      arr.forEach(item => {
        if (item._id) {
          m[item._id.toString()] = item.count
        }
      })
      return m
    }

    const userMap = toMap(userStats)
    const gatewayMap = toMap(gatewayStats)
    const tagMap = toMap(tagStats)

    const stats = companies.map(c => ({
      companyId: c._id,
      name: c.name,
      users: userMap[c._id.toString()] || 0,
      gateways: gatewayMap[c._id.toString()] || 0,
      tags: tagMap[c._id.toString()] || 0,
      readings: readingMap[c._id.toString()] || 0,
      total: (userMap[c._id.toString()] || 0) + (gatewayMap[c._id.toString()] || 0) + (tagMap[c._id.toString()] || 0) + (readingMap[c._id.toString()] || 0)
    }))

    res.json({ success: true, stats })
  } catch (error) {
    next(error)
  }
})

router.get('/backup/export', async (req, res, next) => {
  try {
    const companies = await Company.find({})
    const users = await User.find({}).select('-passwordHash')
    const gateways = await Gateway.find({})
    const configs = await GatewayConfig.find({})
    const tags = await TelemetryTag.find({})
    const readings = await influx.getLatestReadings({ limitCount: 1000 })

    res.json({
      success: true,
      export: {
        exportedAt: new Date(),
        scope: 'global',
        companies,
        users,
        gateways,
        configs,
        tags,
        readings
      }
    })
  } catch (error) {
    next(error)
  }
})

router.get('/backup/export/:companyId', async (req, res, next) => {
  try {
    const companyId = req.params.companyId
    const company = await Company.findById(companyId)
    if (!company) throw createError(404, 'Company not found')

    const users = await User.find({ companyId }).select('-passwordHash')
    const gateways = await Gateway.find({ companyId })
    const configs = await GatewayConfig.find({ companyId })
    const tags = await TelemetryTag.find({ companyId })
    const readings = await influx.getLatestReadings({ companyId: companyId.toString(), limitCount: 1000 })

    res.json({
      success: true,
      export: {
        exportedAt: new Date(),
        scope: 'company',
        companyId,
        companyName: company.name,
        users,
        gateways,
        configs,
        tags,
        readings
      }
    })
  } catch (error) {
    next(error)
  }
})

router.get('/backup/stream-export', async (req, res, next) => {
  try {
    const format = req.query.format === 'csv' ? 'csv' : 'json'
    const companies = await Company.find({})
    const users = await User.find({}).select('-passwordHash')
    const gateways = await Gateway.find({})
    const configs = await GatewayConfig.find({})
    const tags = await TelemetryTag.find({})
    const readings = await influx.getLatestReadings({ limitCount: 1000 })

    const exportData = {
      exportedAt: new Date().toISOString(),
      scope: 'global',
      companies,
      users,
      gateways,
      configs,
      tags,
      readings
    }

    if (format === 'csv') {
      const flatten = (obj, prefix = '') =>
        Object.keys(obj).reduce((acc, k) => {
          const pre = prefix.length ? prefix + '.' : ''
          if (typeof obj[k] === 'object' && !Array.isArray(obj[k]) && obj[k] !== null)
            Object.assign(acc, flatten(obj[k], pre + k))
          else acc[pre + k] = obj[k]
          return acc
        }, {})

      const items = Array.isArray(readings) && readings.length > 0 ? readings : [exportData]
      const headers = Object.keys(flatten(items[0] || {}))
      const csvLines = [headers.join(','), ...items.map(r => headers.map(h => {
        const val = h.split('.').reduce((o, k) => o?.[k], r)
        return typeof val === 'string' && val.includes(',') ? `"${val}"` : val ?? ''
      }).join(','))]
      const csvBuffer = Buffer.from(csvLines.join('\n'), 'utf-8')

      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Length', csvBuffer.length.toString())
      res.setHeader('x-total-bytes', csvBuffer.length.toString())
      res.setHeader('Content-Disposition', 'attachment; filename="full-system-backup.csv"')
      res.setHeader('Access-Control-Expose-Headers', 'x-total-bytes, Content-Length, Content-Disposition')

      const chunkSize = 65536
      for (let i = 0; i < csvBuffer.length; i += chunkSize) {
        res.write(csvBuffer.slice(i, i + chunkSize))
        if (csvBuffer.length > chunkSize) {
          await new Promise(r => setTimeout(r, 15))
        }
      }
      return res.end()
    } else {
      const jsonBuffer = Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8')
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Length', jsonBuffer.length.toString())
      res.setHeader('x-total-bytes', jsonBuffer.length.toString())
      res.setHeader('Content-Disposition', 'attachment; filename="full-system-backup.json"')
      res.setHeader('Access-Control-Expose-Headers', 'x-total-bytes, Content-Length, Content-Disposition')

      const chunkSize = 65536
      for (let i = 0; i < jsonBuffer.length; i += chunkSize) {
        res.write(jsonBuffer.slice(i, i + chunkSize))
        if (jsonBuffer.length > chunkSize) {
          await new Promise(r => setTimeout(r, 15))
        }
      }
      return res.end()
    }
  } catch (error) {
    next(error)
  }
})

router.get('/backup/stream-export/:companyId', async (req, res, next) => {
  try {
    const format = req.query.format === 'csv' ? 'csv' : 'json'
    const companyId = req.params.companyId
    const company = await Company.findById(companyId)
    if (!company) throw createError(404, 'Company not found')

    const users = await User.find({ companyId }).select('-passwordHash')
    const gateways = await Gateway.find({ companyId })
    const configs = await GatewayConfig.find({ companyId })
    const tags = await TelemetryTag.find({ companyId })
    const readings = await influx.getLatestReadings({ companyId: companyId.toString(), limitCount: 1000 })

    const exportData = {
      exportedAt: new Date().toISOString(),
      scope: 'company',
      companyId,
      companyName: company.name,
      users,
      gateways,
      configs,
      tags,
      readings
    }

    const companySlug = company.name.toLowerCase().replace(/\s+/g, '-')

    if (format === 'csv') {
      const flatten = (obj, prefix = '') =>
        Object.keys(obj).reduce((acc, k) => {
          const pre = prefix.length ? prefix + '.' : ''
          if (typeof obj[k] === 'object' && !Array.isArray(obj[k]) && obj[k] !== null)
            Object.assign(acc, flatten(obj[k], pre + k))
          else acc[pre + k] = obj[k]
          return acc
        }, {})

      const items = Array.isArray(readings) && readings.length > 0 ? readings : [exportData]
      const headers = Object.keys(flatten(items[0] || {}))
      const csvLines = [headers.join(','), ...items.map(r => headers.map(h => {
        const val = h.split('.').reduce((o, k) => o?.[k], r)
        return typeof val === 'string' && val.includes(',') ? `"${val}"` : val ?? ''
      }).join(','))]
      const csvBuffer = Buffer.from(csvLines.join('\n'), 'utf-8')

      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Length', csvBuffer.length.toString())
      res.setHeader('x-total-bytes', csvBuffer.length.toString())
      res.setHeader('Content-Disposition', `attachment; filename="company-${companySlug}-backup.csv"`)
      res.setHeader('Access-Control-Expose-Headers', 'x-total-bytes, Content-Length, Content-Disposition')

      const chunkSize = 65536
      for (let i = 0; i < csvBuffer.length; i += chunkSize) {
        res.write(csvBuffer.slice(i, i + chunkSize))
        if (csvBuffer.length > chunkSize) {
          await new Promise(r => setTimeout(r, 15))
        }
      }
      return res.end()
    } else {
      const jsonBuffer = Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8')
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Length', jsonBuffer.length.toString())
      res.setHeader('x-total-bytes', jsonBuffer.length.toString())
      res.setHeader('Content-Disposition', `attachment; filename="company-${companySlug}-backup.json"`)
      res.setHeader('Access-Control-Expose-Headers', 'x-total-bytes, Content-Length, Content-Disposition')

      const chunkSize = 65536
      for (let i = 0; i < jsonBuffer.length; i += chunkSize) {
        res.write(jsonBuffer.slice(i, i + chunkSize))
        if (jsonBuffer.length > chunkSize) {
          await new Promise(r => setTimeout(r, 15))
        }
      }
      return res.end()
    }
  } catch (error) {
    next(error)
  }
})

router.get('/dashboard-summary', async (req, res, next) => {
  try {
    const [companies, managers, employees, gateways, onlineGateways, totalTags, criticalAlerts, paramDistRaw] = await Promise.all([
      Company.countDocuments({}),
      User.countDocuments({ role: 'manager' }),
      User.countDocuments({ role: 'employee' }),
      Gateway.countDocuments({}),
      Gateway.countDocuments({ status: 'online' }),
      TelemetryTag.countDocuments({}),
      TelemetryTag.countDocuments({ lastAlertState: 'critical' }),
      TelemetryTag.aggregate([
        { $group: { _id: { $ifNull: ['$unit', 'General'] }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 6 }
      ])
    ])

    const syncState = typeof backupSync.getState === 'function' ? backupSync.getState() : { active: false }

    const parameterDistribution = paramDistRaw.map(item => ({
      label: item._id && item._id.trim() !== '' ? item._id.trim() : 'General',
      count: item.count
    }))

    res.json({
      success: true,
      summary: {
        companies,
        managers,
        employees,
        gateways,
        onlineGateways,
        totalTags,
        criticalAlerts,
        parameterDistribution,
        syncStatus: syncState
      }
    })
  } catch (error) {
    next(error)
  }
})

// ----------------------------------------------------
// APP SETTINGS
// ----------------------------------------------------
router.get('/settings/group-size', async (req, res, next) => {
  try {
    let setting = await AppSetting.findOne({ key: 'groupSize' })
    if (!setting) {
      setting = await AppSetting.create({ key: 'groupSize', value: 50 })
    }
    res.json({ success: true, groupSize: setting.value })
  } catch (error) {
    next(error)
  }
})

router.put('/settings/group-size', async (req, res, next) => {
  try {
    const { value } = req.body
    const size = parseInt(value, 10)
    if (isNaN(size) || size < 1 || size > 500) {
      throw createError(400, 'Group size must be between 1 and 500')
    }
    const setting = await AppSetting.findOneAndUpdate(
      { key: 'groupSize' },
      { value: size },
      { upsert: true, new: true }
    )
    res.json({ success: true, groupSize: setting.value })
  } catch (error) {
    next(error)
  }
})

router.get('/employees/:id/gateway-tags', async (req, res, next) => {
  try {
    const employee = await User.findById(req.params.id, 'companyId assignedTagIds').lean()
    if (!employee) throw createError(404, 'Employee not found')

    const companyId = employee.companyId?._id || employee.companyId
    if (!companyId) return res.json({ success: true, gateways: [] })

    // Reconcile orphans/duplicates so assign UI never shows deleted params
    try {
      await reconcileCompanyGatewayTags(companyId, req.app.locals)
    } catch (reconcileErr) {
      console.error('[tagSync] reconcileCompanyGatewayTags failed:', reconcileErr.message)
    }

    const assignedSet = new Set(
      await resolveExistingAssignedTagIds(employee.assignedTagIds || [], { pruneUserId: employee._id })
    )

    const gateways = await Gateway.find({ companyId }, 'name prefix').sort({ name: 1 }).lean()
    let tags = await TelemetryTag.find({ companyId }, 'gatewayId topicName parameterName deviceName displayName unit address')
      .populate('gatewayId', 'name prefix')
      .lean()

    tags = await filterTagsToActiveConfigs(tags)

    // Dedupe for response: gateway + normalized param + device
    const seen = new Set()
    tags = tags.filter(t => {
      const gwId = (t.gatewayId?._id || t.gatewayId)?.toString() || ''
      const key = `${gwId}|${(t.parameterName || '').toUpperCase()}|${(t.deviceName || '').toLowerCase()}|${(t.topicName || '').toUpperCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const grouped = gateways.map(gw => ({
      _id: gw._id,
      name: gw.name,
      prefix: gw.prefix,
      tags: tags
        .filter(t => (t.gatewayId?._id || t.gatewayId)?.toString() === gw._id.toString())
        .map(t => ({
          _id: t._id,
          parameterName: t.parameterName,
          deviceName: t.deviceName,
          topicName: t.topicName,
          displayName: t.displayName || '',
          unit: t.unit || '',
          address: t.address,
          assigned: assignedSet.has(t._id.toString())
        }))
    }))

    res.json({ success: true, gateways: grouped })
  } catch (error) {
    next(error)
  }
})

router.get('/managers/:id/detail', async (req, res, next) => {
  try {
    const manager = await User.findById(req.params.id)
      .select('-passwordHash')
      .populate('companyId', 'name')
      .lean()
    if (!manager) throw createError(404, 'Manager not found')

    const companyId = manager.companyId?._id || manager.companyId
    if (!companyId) return res.json({ success: true, manager, company: null, employees: [] })

    const company = companyId ? await Company.findById(companyId, 'name').lean() : null
    const employees = await User.find({ role: 'employee', companyId })
      .select('-passwordHash -profilePhoto')
      .populate('managerId', 'name')
      .sort({ createdAt: -1 })
      .lean()

    const tagCounts = await countExistingAssignedTags(employees)

    const employeesWithCounts = employees.map(e => ({
      _id: e._id,
      name: e.name,
      email: e.email,
      active: e.active,
      assignedTagCount: tagCounts.get(e._id.toString()) || 0,
      createdAt: e.createdAt,
      managerId: e.managerId ? e.managerId.map(m => m._id || m) : [],
      managerName: e.managerId ? e.managerId.map(m => m.name).filter(Boolean).join(', ') : ''
    }))

    res.json({ success: true, manager, company, employees: employeesWithCounts })
  } catch (error) {
    next(error)
  }
})

router.post('/managers/:id/assign-employees', async (req, res, next) => {
  try {
    const managerId = req.params.id
    const { employeeIds } = req.body

    // 1. Unassign this manager from all employees who currently report to them
    await User.updateMany(
      { role: 'employee', managerId: managerId },
      { $pull: { managerId: managerId } }
    )

    // 2. Add this manager to the selected employees' managerId arrays
    if (employeeIds && employeeIds.length > 0) {
      await User.updateMany(
        { role: 'employee', _id: { $in: employeeIds } },
        { $addToSet: { managerId: managerId } }
      )
    }

    res.json({ success: true, message: 'Employees assigned successfully' })
  } catch (error) {
    next(error)
  }
})

router.get('/users/:id', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-passwordHash')
      .populate('companyId', 'name')
      .populate('managerId', 'name')
      .populate('assignedGatewayIds', 'name prefix')
      .populate('assignedTagIds', 'topicName parameterName')
      .lean()
    if (!user) throw createError(404, 'User not found')
    res.json({ success: true, user })
  } catch (error) {
    next(error)
  }
})

router.get('/network-traffic', async (req, res, next) => {
  try {
    const result = await influx.networkTraffic(7)
    res.json({ success: true, ...result })
  } catch (error) {
    next(error)
  }
})

// Get target local MongoDB URI setting
router.get('/settings/local-mongo-uri', async (req, res, next) => {
  try {
    let setting = await AppSetting.findOne({ key: 'local_mongo_uri' })
    if (!setting) {
      setting = await AppSetting.create({ key: 'local_mongo_uri', value: 'mongodb://127.0.0.1:27017/local_iot_backup' })
    }
    res.json({ success: true, localMongoUri: setting.value })
  } catch (error) {
    next(error)
  }
})

// Update target local MongoDB URI setting
router.put('/settings/local-mongo-uri', async (req, res, next) => {
  try {
    const { localMongoUri } = req.body
    if (!localMongoUri || !localMongoUri.startsWith('mongodb')) {
      throw createError(400, 'Invalid MongoDB connection string')
    }
    const setting = await AppSetting.findOneAndUpdate(
      { key: 'local_mongo_uri' },
      { value: localMongoUri.trim() },
      { upsert: true, new: true }
    )
    res.json({ success: true, localMongoUri: setting.value })
  } catch (error) {
    next(error)
  }
})

// Get current state of BackupSyncManager
router.get('/backup/sync/status', (req, res) => {
  res.json({ success: true, syncStatus: backupSync.getState() })
})

// Test connection to a MongoDB connection string
router.post('/backup/sync/test-connection', async (req, res, next) => {
  try {
    const { localMongoUri } = req.body
    if (!localMongoUri || !localMongoUri.startsWith('mongodb')) {
      throw createError(400, 'Invalid MongoDB connection URI')
    }

    const testConn = mongoose.createConnection(localMongoUri, {
      serverSelectionTimeoutMS: 3000
    })
    await testConn.asPromise()
    await testConn.close()

    res.json({ success: true, message: 'Connection successful!' })
  } catch (error) {
    res.json({ success: false, message: error.message })
  }
})

// Trigger database backup sync to local MongoDB
router.post('/backup/sync/start', async (req, res, next) => {
  try {
    const { localMongoUri } = req.body
    const localUri = localMongoUri || (await AppSetting.findOne({ key: 'local_mongo_uri' }))?.value || 'mongodb://127.0.0.1:27017/local_iot_backup'

    await backupSync.start(localUri, req.app.locals.io)
    res.json({ success: true, message: 'Sync process initialized', syncStatus: backupSync.getState() })
  } catch (error) {
    next(error)
  }
})

// Pause database sync
router.post('/backup/sync/pause', async (req, res) => {
  await backupSync.pause()
  res.json({ success: true, syncStatus: backupSync.getState() })
})

// Resume database sync
router.post('/backup/sync/resume', async (req, res) => {
  await backupSync.resume()
  res.json({ success: true, syncStatus: backupSync.getState() })
})

// Cancel and reset database sync
router.post('/backup/sync/stop', async (req, res) => {
  await backupSync.stop()
  res.json({ success: true, syncStatus: backupSync.getState() })
})

// ----------------------------------------------------
// SMTP SETTINGS
// ----------------------------------------------------
router.get('/settings/smtp', async (req, res, next) => {
  try {
    let setting = await AppSetting.findOne({ key: 'smtpConfig' })
    const config = setting ? setting.value : {
      host: 'smtp.gmail.com',
      port: 587,
      user: '',
      pass: '',
      secure: false,
      fromEmail: '',
      enableAlerts: true
    }
    res.json({ success: true, config })
  } catch (error) {
    next(error)
  }
})

router.put('/settings/smtp', async (req, res, next) => {
  try {
    const { host, port, user, pass, secure, fromEmail, enableAlerts } = req.body
    if (!host || !user) {
      throw createError(400, 'SMTP Host and User Email ID are required.')
    }

    const currentSetting = await AppSetting.findOne({ key: 'smtpConfig' })
    const currentPass = currentSetting?.value?.pass || ''

    const configValue = {
      host: host.trim(),
      port: parseInt(port, 10) || 587,
      user: user.trim(),
      pass: pass !== undefined && pass !== '' ? pass.trim() : currentPass,
      secure: secure === true || parseInt(port, 10) === 465,
      fromEmail: (fromEmail || user).trim(),
      enableAlerts: enableAlerts !== false
    }

    const setting = await AppSetting.findOneAndUpdate(
      { key: 'smtpConfig' },
      { value: configValue },
      { upsert: true, new: true }
    )

    res.json({ success: true, config: setting.value, message: 'SMTP settings saved successfully' })
  } catch (error) {
    next(error)
  }
})

router.post('/settings/smtp/test', async (req, res, next) => {
  try {
    const targetEmail = req.body.targetEmail || req.user.email
    if (!targetEmail) throw createError(400, 'Target email address is required')

    await emailService.sendTestEmail(targetEmail, req.body.config)
    res.json({ success: true, message: `Test email sent successfully to ${targetEmail}!` })
  } catch (error) {
    res.json({ success: false, message: error.message || 'SMTP Test Connection Failed' })
  }
})

router.post('/settings/smtp/test-alert', async (req, res, next) => {
  try {
    const targetEmail = req.body.targetEmail || req.user.email || 'sarayuvs12@gmail.com'
    const mockTag = {
      parameterName: req.body.parameterName || 'Temperature',
      displayName: req.body.displayName || 'Main Boiler Sensor',
      deviceName: req.body.deviceName || 'Simulation Node 1',
      unit: req.body.unit || '°C',
      criticalThreshold: req.body.criticalThreshold || 75.0,
      warningThreshold: req.body.warningThreshold || 60.0
    }
    const result = await emailService.sendThresholdAlertEmail({
      tag: mockTag,
      value: req.body.value || 89.4,
      severity: req.body.severity || 'critical',
      recipientEmails: [targetEmail],
      companyName: req.body.companyName || 'Sarayu Enterprises',
      gatewayName: req.body.gatewayName || 'Gateway-01',
      overrideConfig: req.body.config
    })
    res.json({ success: true, message: `Critical alert sample email sent successfully to ${targetEmail}!`, info: result })
  } catch (error) {
    res.json({ success: false, message: error.message || 'Failed to dispatch critical alert sample email' })
  }
})

// ----------------------------------------------------
// THRESHOLDS MANAGEMENT (ADMIN)
// ----------------------------------------------------
router.get('/thresholds', async (req, res, next) => {
  try {
    const { companyId, gatewayId, search, page, limit } = req.query
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100)

    const filter = {}
    if (companyId) filter.companyId = companyId
    if (gatewayId) filter.gatewayId = gatewayId
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
      .populate('companyId', 'name')
      .populate('gatewayId', 'name prefix')
      .populate('assignedEmployeeIds', 'name email')
      .sort({ companyId: 1, gatewayId: 1, parameterName: 1 })
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

    const tag = await TelemetryTag.findByIdAndUpdate(req.params.tagId, updateData, { new: true })
      .populate('companyId', 'name')
      .populate('gatewayId', 'name prefix')
      .populate('assignedEmployeeIds', 'name email')

    if (!tag) throw createError(404, 'Telemetry Tag not found')

    cache.flush()

    res.json({ success: true, tag, message: 'Threshold settings saved successfully' })
  } catch (error) {
    next(error)
  }
})

// ----------------------------------------------------
// VISUALIZATIONS MANAGEMENT (ADMIN)
// ----------------------------------------------------

// Fetch tags for Admin Visualization Assignment Center (Company-scoped)
router.get('/visualizations/tags', async (req, res, next) => {
  try {
    const { companyId, gatewayId, search, page, limit } = req.query
    if (!companyId) throw createError(400, 'companyId query parameter is required')

    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(parseInt(limit, 10) || 10, 100)

    let filter = { companyId }
    if (gatewayId && gatewayId !== 'all') {
      filter.gatewayId = gatewayId
    }

    try {
      const { reconcileCompanyGatewayTags, reconcileGatewayTags } = require('../services/tagSync')
      if (gatewayId && gatewayId !== 'all') {
        await reconcileGatewayTags(gatewayId, req.app.locals)
      } else {
        await reconcileCompanyGatewayTags(companyId, req.app.locals)
      }
    } catch (recErr) {
      console.error('[AdminVisualizations] Reconcile tags error:', recErr.message)
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
      .populate('companyId', 'name')
      .populate('gatewayId', 'name prefix location')
      .populate('assignedEmployeeIds', 'name email addressLabel')
      .sort({ parameterName: 1 })
      .collation({ locale: 'en', numericOrdering: true })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean()

    const mappedTags = tags.map(tag => ({
      _id: tag._id.toString(),
      tagId: tag._id.toString(),
      parameterName: tag.parameterName,
      displayName: tag.displayName || '',
      deviceName: tag.deviceName,
      topicName: tag.topicName,
      unit: tag.unit || '',
      liveValue: tag.latestValue ?? null,
      company: tag.companyId ? { id: tag.companyId._id, name: tag.companyId.name } : null,
      gateway: tag.gatewayId ? { id: tag.gatewayId._id, name: tag.gatewayId.name, prefix: tag.gatewayId.prefix } : null,
      assignedGraphType: tag.assignedGraphType || null,
      assignedMeterType: tag.assignedMeterType || null,
      meterMin: tag.meterMin ?? null,
      meterMax: tag.meterMax ?? null,
      assignedUsers: (tag.assignedEmployeeIds || []).map(u => ({
        _id: u._id.toString(),
        name: u.addressLabel || u.name,
        email: u.email
      }))
    }))

    res.json({ success: true, tags: mappedTags, total, page: pageNum, limit: limitNum })
  } catch (error) {
    next(error)
  }
})

// Assign graph or meter visualization to a tag (Admin)
router.put('/visualizations/tags/:tagId', async (req, res, next) => {
  try {
    const { tagId } = req.params
    const { companyId, gatewayId, type, value, meterMin, meterMax, meterIdle, meterColor } = req.body

    if (!type || !['graph', 'meter', 'clear_graph', 'clear_meter', 'clear_all'].includes(type)) {
      throw createError(400, 'Invalid visualization type')
    }

    const tag = await TelemetryTag.findById(tagId)
    if (!tag) throw createError(404, 'Telemetry Tag not found')

    if (companyId && tag.companyId && tag.companyId.toString() !== companyId.toString()) {
      throw createError(400, 'Selected parameter tag does not belong to the currently selected company context')
    }

    if (gatewayId && gatewayId !== 'all' && tag.gatewayId && tag.gatewayId.toString() !== gatewayId.toString()) {
      throw createError(400, 'Selected parameter tag does not belong to the currently selected gateway context')
    }

    let updateData = {}
    if (type === 'graph') {
      if (!value) throw createError(400, 'Graph visualization type value is required')
      updateData.assignedGraphType = value
    } else if (type === 'meter') {
      if (!value) throw createError(400, 'Digital meter type value is required')
      const minVal = meterMin !== undefined && meterMin !== null && meterMin !== '' ? Number(meterMin) : 0
      const maxVal = meterMax !== undefined && meterMax !== null && meterMax !== '' ? Number(meterMax) : 100

      if (isNaN(minVal) || isNaN(maxVal)) {
        throw createError(400, 'Meter Minimum and Maximum bounds must be valid numbers')
      }
      if (minVal >= maxVal) {
        throw createError(400, 'Meter Minimum must be strictly less than Meter Maximum')
      }

      updateData.assignedMeterType = value
      updateData.meterMin = minVal
      updateData.meterMax = maxVal
      updateData.meterIdle = meterIdle !== undefined && meterIdle !== null && meterIdle !== '' ? Number(meterIdle) : 0
      updateData.meterColor = meterColor || '#22c55e'
    } else if (type === 'clear_graph') {
      updateData.assignedGraphType = null
    } else if (type === 'clear_meter') {
      updateData.assignedMeterType = null
      updateData.meterMin = null
      updateData.meterMax = null
      updateData.meterIdle = 0
      updateData.meterColor = null
    } else if (type === 'clear_all') {
      updateData.assignedGraphType = null
      updateData.assignedMeterType = null
      updateData.meterMin = null
      updateData.meterMax = null
      updateData.meterIdle = 0
      updateData.meterColor = null
    }

    const updatedTag = await TelemetryTag.findByIdAndUpdate(tagId, updateData, { new: true })
      .populate('companyId', 'name')
      .populate('gatewayId', 'name prefix')
      .lean()

    cache.flush()

    const io = req.app.locals.io
    if (io) {
      io.to('admins').emit('telemetry:visualization-updated', { tagId: updatedTag._id.toString() })
      if (updatedTag.companyId) {
        const companyIdStr = typeof updatedTag.companyId === 'object' ? updatedTag.companyId._id.toString() : updatedTag.companyId.toString()
        io.to(`company:${companyIdStr}`).emit('telemetry:visualization-updated', { tagId: updatedTag._id.toString() })
        io.to(`company:${companyIdStr}`).emit('dashboard:refresh-required', {})
      }
    }

    logActivity({
      user: req.user,
      companyId: tag.companyId,
      action: 'ASSIGN_VISUALIZATION',
      category: 'Telemetry',
      details: `Admin assigned ${type} visualization (${value || 'clear'}) to parameter "${tag.parameterName}" (${tag.displayName || tag.topicName})`,
      req
    })

    res.json({
      success: true,
      message: 'Visualization assignment saved successfully',
      tag: {
        _id: updatedTag._id.toString(),
        assignedGraphType: updatedTag.assignedGraphType,
        assignedMeterType: updatedTag.assignedMeterType,
        meterMin: updatedTag.meterMin,
        meterMax: updatedTag.meterMax,
        meterIdle: updatedTag.meterIdle,
        meterColor: updatedTag.meterColor
      }
    })
  } catch (error) {
    next(error)
  }
})

router.use('/asset-twins', require('./adminAssetTwins'))

module.exports = router
