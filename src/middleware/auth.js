const jwt = require('jsonwebtoken')
const createError = require('http-errors')
const User = require('../models/User')

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw createError(401, 'Unauthorized: No token provided')
    }

    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    const user = await User.findById(decoded.id).select('-passwordHash')
    if (!user || !user.active) {
      throw createError(401, 'Unauthorized: User not found or inactive')
    }

    req.user = user
    next()
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      next(createError(401, 'Unauthorized: Invalid token'))
    } else {
      next(error)
    }
  }
}

const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(createError(403, 'Forbidden: Insufficient permissions'))
    }
    next()
  }
}

module.exports = {
  authenticate,
  authorizeRoles
}
