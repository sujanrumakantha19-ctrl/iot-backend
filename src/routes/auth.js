const router = require('express').Router()
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const createError = require('http-errors')
const User = require('../models/User')
const Company = require('../models/Company')
const { logActivity } = require('../services/activityLogger')
const { authenticate } = require('../middleware/auth')

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      throw createError(400, 'Email and password are required')
    }

    const user = await User.findOne({ email })
    if (!user || !user.active) {
      throw createError(401, 'Invalid email or password')
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash)
    if (!isMatch) {
      throw createError(401, 'Invalid email or password')
    }

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )

    let companyName = null
    if (user.companyId) {
      const company = await Company.findById(user.companyId)
      if (company) companyName = company.name
    }

    logActivity({
      user,
      companyName,
      action: 'USER_LOGIN',
      category: 'Security',
      details: `${user.role.toUpperCase()} ${user.name} logged in successfully`,
      req
    })

    res.json({
      success: true,
      session: {
        userId: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        companyId: user.companyId ? user.companyId.toString() : null,
        companyName,
        managerId: user.managerId ? user.managerId.toString() : null,
        themePreference: user.themePreference || 'default',
        assignPermissionMode: user.assignPermissionMode || 'all',
        allowedGraphIds: user.allowedGraphIds || [],
        allowedMeterTypes: user.allowedMeterTypes || [],
        featurePermissions: user.featurePermissions || {
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
        token
      }
    })
  } catch (error) {
    next(error)
  }
})

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const userObj = req.user.toObject ? req.user.toObject() : { ...req.user }
    if (!userObj.featurePermissions) {
      userObj.featurePermissions = {
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
      }
    }
    res.json({
      success: true,
      user: userObj
    })
  } catch (error) {
    next(error)
  }
})

router.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) {
      throw createError(400, 'Current password and new password are required')
    }

    const user = await User.findById(req.user._id)
    if (!user) throw createError(404, 'User not found')

    const isMatch = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!isMatch) {
      throw createError(400, 'Incorrect current password')
    }

    const salt = await bcrypt.genSalt(10)
    user.passwordHash = await bcrypt.hash(newPassword, salt)
    await user.save()

    res.json({ success: true, message: 'Password updated successfully' })
  } catch (error) {
    next(error)
  }
})

// Profile update endpoint
router.put('/profile', authenticate, async (req, res, next) => {
  try {
    const { name, email, profilePhoto, addressLabel, address } = req.body
    const user = await User.findById(req.user._id)
    if (!user) throw createError(404, 'User not found')

    if (name) user.name = name
    if (email && email !== user.email) {
      const existing = await User.findOne({ email, _id: { $ne: user._id } })
      if (existing) throw createError(400, 'Email address is already in use')
      user.email = email
    }
    if (profilePhoto !== undefined) user.profilePhoto = profilePhoto
    if (addressLabel !== undefined) user.addressLabel = addressLabel
    if (address !== undefined) user.address = address

    await user.save()

    const userObj = user.toObject()
    delete userObj.passwordHash

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: userObj
    })
  } catch (error) {
    next(error)
  }
})

// Preferences endpoints
router.get('/preferences', authenticate, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id)
    if (!user) throw createError(404, 'User not found')
    res.json({
      success: true,
      themePreference: user.themePreference || 'default'
    })
  } catch (error) {
    next(error)
  }
})

router.put('/preferences', authenticate, async (req, res, next) => {
  try {
    const { themePreference } = req.body
    const validThemes = [
      'default', 'midnight', 'forest', 'oceanic', 'sunset', 'cyberpunk',
      'aquabreeze', 'lavender', 'solarsand', 'nordicsnow', 'crimson', 'monochrome'
    ]
    if (!themePreference || !validThemes.includes(themePreference)) {
      throw createError(400, 'Invalid theme preference')
    }

    const user = await User.findById(req.user._id)
    if (!user) throw createError(404, 'User not found')

    user.themePreference = themePreference
    await user.save()

    res.json({
      success: true,
      themePreference: user.themePreference
    })
  } catch (error) {
    next(error)
  }
})

router.get('/company', authenticate, async (req, res, next) => {
  try {
    if (!req.user.companyId) {
      return res.json({ success: true, company: null })
    }
    const company = await Company.findById(req.user.companyId)
    res.json({ success: true, company })
  } catch (error) {
    next(error)
  }
})

module.exports = router
