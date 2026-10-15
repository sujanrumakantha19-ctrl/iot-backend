const mongoose = require('mongoose')
const router = require('express').Router()
const createError = require('http-errors')
const ActivityLog = require('../models/ActivityLog')

// GET /api/admin/activity-logs/users — Unique User Cards with backend pagination (12 per page)
router.get('/users', async (req, res, next) => {
  try {
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 12)) // Default 12 users per page
    const { search, companyId, role } = req.query

    const matchFilter = {}

    if (companyId && companyId !== 'all') {
      try {
        matchFilter.companyId = new mongoose.Types.ObjectId(companyId)
      } catch (_) {
        matchFilter.companyId = companyId
      }
    }

    if (role && role !== 'all') {
      matchFilter.userRole = role
    }

    if (search && search.trim() !== '') {
      const q = search.trim()
      matchFilter.$or = [
        { userName: { $regex: q, $options: 'i' } },
        { userEmail: { $regex: q, $options: 'i' } },
        { userPhone: { $regex: q, $options: 'i' } }
      ]
    }

    const pipeline = [
      { $match: matchFilter },
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: { $ifNull: ['$userId', '$userEmail'] },
          userId: { $first: '$userId' },
          userName: { $first: '$userName' },
          userEmail: { $first: '$userEmail' },
          userPhone: { $first: '$userPhone' },
          userRole: { $first: '$userRole' },
          companyId: { $first: '$companyId' },
          companyName: { $first: '$companyName' },
          totalActivities: { $sum: 1 },
          lastActiveAt: { $max: '$timestamp' },
          lastAction: { $first: '$action' }
        }
      },
      { $sort: { lastActiveAt: -1 } },
      {
        $facet: {
          metadata: [{ $count: 'total' }],
          data: [{ $skip: (pageNum - 1) * limitNum }, { $limit: limitNum }]
        }
      }
    ]

    const result = await ActivityLog.aggregate(pipeline)
    const total = result[0]?.metadata[0]?.total || 0
    const users = result[0]?.data || []
    const totalPages = Math.ceil(total / limitNum) || 1

    res.json({
      success: true,
      users,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages
    })
  } catch (error) {
    next(error)
  }
})

// GET /api/admin/activity-logs/timeline — Infinite scroll timeline for a specific user with date range filtering
router.get('/timeline', async (req, res, next) => {
  try {
    const { userId, userEmail, startDate, endDate, category, page = 1, limit = 15 } = req.query
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 15))

    const filter = {}

    if (userId) {
      filter.$or = [{ userId }, { userEmail: userEmail || '' }]
    } else if (userEmail) {
      filter.userEmail = userEmail
    }

    if (category && category !== 'all') {
      filter.category = category
    }

    // Date Picker range filtering
    if (startDate || endDate) {
      filter.timestamp = {}
      if (startDate) {
        const start = new Date(startDate)
        start.setHours(0, 0, 0, 0)
        filter.timestamp.$gte = start
      }
      if (endDate) {
        const end = new Date(endDate)
        end.setHours(23, 59, 59, 999)
        filter.timestamp.$lte = end
      }
    }

    const total = await ActivityLog.countDocuments(filter)
    const totalPages = Math.ceil(total / limitNum) || 1

    const logs = await ActivityLog.find(filter)
      .populate('companyId', 'name')
      .sort({ timestamp: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean()

    const hasMore = pageNum < totalPages

    res.json({
      success: true,
      logs,
      total,
      page: pageNum,
      totalPages,
      hasMore
    })
  } catch (error) {
    next(error)
  }
})

// GET /api/admin/activity-logs/stats — High-level summary metrics
router.get('/stats', async (req, res, next) => {
  try {
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)

    const [totalLogs, todayLogs, securityEvents, gatewayEvents] = await Promise.all([
      ActivityLog.countDocuments({}),
      ActivityLog.countDocuments({ timestamp: { $gte: startOfToday } }),
      ActivityLog.countDocuments({ category: 'Security' }),
      ActivityLog.countDocuments({ category: 'Gateway' })
    ])

    res.json({
      success: true,
      stats: {
        totalLogs,
        todayLogs,
        securityEvents,
        gatewayEvents
      }
    })
  } catch (error) {
    next(error)
  }
})

module.exports = router
