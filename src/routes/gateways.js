const router = require('express').Router()
const createError = require('http-errors')
const Gateway = require('../models/Gateway')
const Company = require('../models/Company')
const GatewayConfig = require('../models/GatewayConfig')
const TelemetryTag = require('../models/TelemetryTag')
const Firmware = require('../models/Firmware')
const { logActivity } = require('../services/activityLogger')
const { cleanupGroupCascade } = require('../services/gatewayCleanup')
const { reconcileGatewayTags } = require('../services/tagSync')

const checkGatewayPermission = async (user, gatewayId, actionType = 'manage') => {
  if (user.role === 'admin') return true

  if (user.role === 'manager') {
    const gateway = await Gateway.findById(gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    if (gateway.companyId?.toString() !== user.companyId?.toString()) {
      throw createError(403, 'Forbidden: Gateway does not belong to your company')
    }

    const fp = user.featurePermissions || {}
    if (!fp.showGateway) {
      throw createError(403, 'Forbidden: Gateway management access is disabled for your manager account')
    }

    if (actionType === 'deleteGroup' || actionType === 'writeConfig' || actionType === 'publish') {
      const canPublish = fp.gatewayFeatures?.showPublish !== false
      if (!canPublish) {
        throw createError(403, 'Forbidden: You do not have permission to execute gateway configuration commands')
      }
    }
    return true
  }

  throw createError(403, 'Forbidden: Employee accounts cannot modify gateway configurations')
}

const validateConfigRows = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw createError(400, 'Config rows must be a non-empty array')
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!r.deviceName) throw createError(400, `Row ${i + 1}: Device Name is required`)
    if (!r.parameterName) throw createError(400, `Row ${i + 1}: Parameter Name is required`)
    if (isNaN(r.slaveId) || r.slaveId < 0 || r.slaveId > 255) throw createError(400, `Row ${i + 1}: Invalid Slave ID`)
    if (isNaN(r.functionCode) || r.functionCode < 0 || r.functionCode > 255) throw createError(400, `Row ${i + 1}: Invalid Function Code`)
    if (r.address === '' || r.address === null || r.address === undefined || isNaN(Number(r.address)) || Number(r.address) < 0 || Number(r.address) > 65535) {
      throw createError(400, `Row ${i + 1} (${r.parameterName}): Address is required and must be between 0 and 65535`)
    }
    if (isNaN(r.length) || r.length < 1 || r.length > 65535) throw createError(400, `Row ${i + 1}: Invalid Length`)
    if (typeof r.dataType !== 'string') throw createError(400, `Row ${i + 1}: Invalid Data Type`)
    if (isNaN(r.scaleFactor)) throw createError(400, `Row ${i + 1}: Invalid Scale Factor`)
    if (r.decimal !== undefined && (isNaN(r.decimal) || r.decimal < 0 || r.decimal > 6)) throw createError(400, `Row ${i + 1}: Invalid Decimal value (must be 0-6)`)
    if (isNaN(r.baudRate) || r.baudRate <= 0) throw createError(400, `Row ${i + 1}: Invalid Baud Rate`)
    if (!r.serialConfig) throw createError(400, `Row ${i + 1}: Serial Config is required`)
  }
}

const BAUD_RATES = [110, 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

const normalizeBaudRate = (rate) => {
  const num = Number(rate)
  if (isNaN(num) || num <= 0) return 115200
  // If it's a 1-based hardware protocol index (1..15), map to actual baud rate
  if (num >= 1 && num <= 15) return BAUD_RATES[num - 1] || 115200
  if (BAUD_RATES.includes(num)) return num
  return 115200
}

const getBaudRateIndex = (rate) => {
  const num = Number(rate)
  if (num >= 1 && num <= 15) return num
  const idx = BAUD_RATES.indexOf(num)
  return idx !== -1 ? idx + 1 : 12 // default to 12 (115200)
}

const generateMqttPayload = (rows, startIdx = 0) => {
  const rowParts = rows.map((r, idx) => {
    // Use stored parameter name with capital P (e.g. P1, P2)
    const pLabel = r.parameterName ? r.parameterName.replace(/^[tp](\d+)$/i, 'P$1') : `P${startIdx + idx + 1}`
    return [
      pLabel,
      String(r.slaveId),
      String(r.functionCode),
      String(r.address),
      r.dataType.toLowerCase(),
      String(r.length),
      String(getBaudRateIndex(r.baudRate)),
      r.serialConfig || '8N1'
    ].join(',')
  })

  return rowParts.join(';') + ';'
}

// Fetch single gateway detail
router.get('/:gatewayId', async (req, res, next) => {
  try {
    const { gatewayId } = req.params
    const gateway = await Gateway.findById(gatewayId).lean()
    if (!gateway) throw createError(404, 'Gateway not found')

    if (req.user.role !== 'admin' && String(gateway.companyId) !== String(req.user.companyId)) {
      throw createError(403, 'Forbidden: Gateway does not belong to your company')
    }

    res.json({ success: true, gateway })
  } catch (error) {
    next(error)
  }
})

// Fetch latest configuration for a gateway
router.get('/:gatewayId/config', async (req, res, next) => {
  try {
    await checkGatewayPermission(req.user, req.params.gatewayId, 'viewConfig')
    const config = await GatewayConfig.findOne({ gatewayId: req.params.gatewayId }).sort({ createdAt: -1 })
    res.json({ success: true, config: config || { rows: [], groups: [], groupCount: 1 } })
  } catch (error) {
    next(error)
  }
})

// Fetch configuration history for a gateway
router.get('/:gatewayId/config-history', async (req, res, next) => {
  try {
    await checkGatewayPermission(req.user, req.params.gatewayId, 'viewConfig')
    const list = await GatewayConfig.find({ gatewayId: req.params.gatewayId })
      .sort({ createdAt: -1 })
      .select('version publishStatus publishedAt createdAt groupCount groups')
    res.json({ success: true, history: list })
  } catch (error) {
    next(error)
  }
})

// Fetch a specific config version
router.get('/:gatewayId/config/:configId', async (req, res, next) => {
  try {
    await checkGatewayPermission(req.user, req.params.gatewayId, 'viewConfig')
    const config = await GatewayConfig.findOne({ _id: req.params.configId, gatewayId: req.params.gatewayId })
    if (!config) throw createError(404, 'Config not found')
    res.json({ success: true, config })
  } catch (error) {
    next(error)
  }
})

// Publish Modbus configuration (accepts groups array with stable groupNums)
// Body: { groups: [{ groupNum: 1, rows: [...] }, ...] }
router.post('/:gatewayId/config', async (req, res, next) => {
  try {
    await checkGatewayPermission(req.user, req.params.gatewayId, 'writeConfig')
    const { groups } = req.body
    if (!Array.isArray(groups) || groups.length === 0) {
      throw createError(400, 'Groups must be a non-empty array')
    }

    const gateway = await Gateway.findById(req.params.gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    const maxAllowedParams = gateway.maxParameters || (gateway.maxGroups ? gateway.maxGroups * 50 : 1000)
    const maxAllowedGroups = Math.ceil(maxAllowedParams / 50)
    if (groups.length > maxAllowedGroups) {
      throw createError(400, `Configuration payload exceeds maximum ${maxAllowedGroups} groups limit (${groups.length} groups provided for ${maxAllowedParams} max parameters).`)
    }

    const company = await Company.findById(gateway.companyId)
    if (!company) throw createError(404, 'Company not found')

    // Normalize to [{ groupNum, rows }] format with normalized baud rates
    const normalizedGroups = groups.map((g, i) => ({
      groupNum: g.groupNum != null ? Number(g.groupNum) : i + 1,
      rows: (Array.isArray(g.rows) ? g.rows : g).map(r => ({
        ...r,
        baudRate: normalizeBaudRate(r.baudRate),
        decimal: (r.decimal !== undefined && r.decimal !== null && String(r.decimal).toLowerCase() !== 'none') ? Number(r.decimal) : 'None'
      }))
    }))

    // Generate per-group MQTT payloads (offset by position in list, not groupNum)
    let startIdx = 0
    const groupPayloads = []
    for (const g of normalizedGroups) {
      groupPayloads.push({ groupNum: g.groupNum, payload: generateMqttPayload(g.rows, startIdx) })
      startIdx += g.rows.length
    }

    const mqttClient = req.app.locals.mqttClient
    if (!mqttClient || !mqttClient.connected) {
      throw createError(503, 'MQTT Broker disconnected. Cannot publish configuration.')
    }

    // Load latest config to preserve existing groups and pendingBoardDeletes if doing incremental group update
    let existingPendingDeletes = []
    const existingGroupsMap = new Map()

    try {
      const lastConfig = await GatewayConfig.findOne({ gatewayId: gateway._id }).sort({ createdAt: -1 })
      if (lastConfig) {
        if (lastConfig.pendingBoardDeletes) {
          existingPendingDeletes = lastConfig.pendingBoardDeletes.toObject ? lastConfig.pendingBoardDeletes.toObject() : lastConfig.pendingBoardDeletes
        }
        if (lastConfig.groups && Array.isArray(lastConfig.groups) && req.body.replace !== true) {
          for (const g of lastConfig.groups) {
            const gObj = g.toObject ? g.toObject() : g
            existingGroupsMap.set(Number(gObj.groupNum), {
              groupNum: Number(gObj.groupNum),
              rows: gObj.rows || [],
              publishStatus: gObj.publishStatus || lastConfig.publishStatus || 'success',
              publishedAt: gObj.publishedAt || null
            })
          }
        }
      }
    } catch (_) {}

    // Overlay incoming normalized groups into existingGroupsMap
    for (const g of normalizedGroups) {
      existingGroupsMap.set(Number(g.groupNum), {
        groupNum: Number(g.groupNum),
        rows: g.rows,
        publishStatus: 'pending',
        publishedAt: null
      })
    }

    // Final merged groups sorted by groupNum
    const finalGroups = Array.from(existingGroupsMap.values()).sort((a, b) => a.groupNum - b.groupNum)
    if (finalGroups.length > maxAllowedGroups) {
      throw createError(400, `Gateway cannot exceed maximum ${maxAllowedGroups} groups (${finalGroups.length} groups present for ${maxAllowedParams} max parameters).`)
    }
    const allRows = finalGroups.flatMap(g => g.rows)
    if (allRows.length > maxAllowedParams) {
      throw createError(400, `Total parameters (${allRows.length}) exceed maximum allowed limit of ${maxAllowedParams} parameters for this gateway.`)
    }

    // Validate per-group parameter capacity based on maxAllowedParams
    for (let i = 0; i < finalGroups.length; i++) {
      const g = finalGroups[i]
      const gNum = g.groupNum || i + 1
      const gMax = Math.min(50, Math.max(0, maxAllowedParams - (gNum - 1) * 50))
      if (g.rows.length > gMax) {
        throw createError(400, `Group G${gNum} contains ${g.rows.length} parameters, exceeding its allowed maximum of ${gMax} parameters (Gateway max: ${maxAllowedParams}).`)
      }
    }

    const fullPayload = generateMqttPayload(allRows)
    const groupCount = finalGroups.length

    // Auto-sync gateway.devices from allRows so slaveId <-> deviceName mappings are saved on Gateway model
    const deviceMap = new Map()
    if (gateway.devices && Array.isArray(gateway.devices)) {
      for (const d of gateway.devices) {
        if (d.deviceName && d.slaveId != null) {
          deviceMap.set(Number(d.slaveId), {
            deviceName: d.deviceName,
            baudRate: normalizeBaudRate(d.baudRate),
            serialConfig: d.serialConfig || '8N1'
          })
        }
      }
    }
    for (const r of allRows) {
      if (r.deviceName && r.slaveId != null) {
        const existing = deviceMap.get(Number(r.slaveId)) || {}
        deviceMap.set(Number(r.slaveId), {
          deviceName: r.deviceName,
          baudRate: normalizeBaudRate(r.baudRate || existing.baudRate),
          serialConfig: r.serialConfig || existing.serialConfig || '8N1'
        })
      }
    }
    const updatedDevices = Array.from(deviceMap.entries()).map(([slaveId, data]) => ({
      slaveId: Number(slaveId),
      deviceName: data.deviceName,
      baudRate: normalizeBaudRate(data.baudRate),
      serialConfig: data.serialConfig || '8N1'
    })).sort((a, b) => a.slaveId - b.slaveId)

    if (updatedDevices.length > 0) {
      gateway.devices = updatedDevices
      await gateway.save()
    }

    // Save to GatewayConfig — stores full merged set of groups so no groups are lost!
    const config = await GatewayConfig.create({
      companyId: company._id,
      gatewayId: gateway._id,
      rows: allRows,
      groups: finalGroups,
      payload: fullPayload,
      groupCount,
      publishStatus: 'pending',
      publishedAt: null,
      pendingBoardDeletes: existingPendingDeletes,
      createdBy: req.user._id
    })

    logActivity({
      user: req.user,
      companyId: company._id,
      companyName: company.name,
      action: 'PUBLISH_CONFIG',
      category: 'Gateway',
      details: `Published Modbus configuration (${allRows.length} parameters, ${groupCount} groups) to gateway "${gateway.name}" (${gateway.prefix})`,
      req
    })

    // Publish each group using its stable groupNum as the topic segment
    let publishedCount = 0
    const publishErrors = []

    for (const { groupNum, payload: groupPayload } of groupPayloads) {
      const mqttTopic = `${gateway.prefix}/Setconfig/G${groupNum}`

      mqttClient.publish(mqttTopic, groupPayload, { qos: 1 }, async (err) => {
        if (err) {
          publishErrors.push(`G${groupNum}: ${err.message}`)
        } else {
          publishedCount++
          console.log(`[MQTT] Config G${groupNum} published to ${mqttTopic}`)
        }

        if (publishedCount + publishErrors.length >= groupPayloads.length) {
          const io = req.app.locals.io
          if (publishErrors.length === 0) {
            // Upsert TelemetryTags so data pipeline is ready
            for (const r of allRows) {
              const pName = (r.parameterName || '').replace(/^[tp](\d+)$/i, 'P$1')
              const topicName = r.topicName ? r.topicName.replace(/^[tp](\d+)$/i, 'P$1') : pName
              const decVal = (r.decimal !== undefined && r.decimal !== null && String(r.decimal).toLowerCase() !== 'none') ? Number(r.decimal) : 'None'
              const sfNum = (r.scaleFactor !== undefined && r.scaleFactor !== null && !isNaN(Number(r.scaleFactor))) ? Number(r.scaleFactor) : 1
              const defaultTelemetryTopic = `${company.slug || company._id}/${gateway.prefix}/${topicName.toLowerCase()}`

              // Find existing tag by parameterName, topicName, or address for this gateway
              const existingTag = await TelemetryTag.findOne({
                gatewayId: gateway._id,
                $or: [
                  { parameterName: new RegExp(`^${pName}$`, 'i') },
                  { topicName: new RegExp(`^${topicName}$`, 'i') },
                  { address: r.address }
                ]
              })

              const tagData = {
                companyId: company._id,
                gatewayId: gateway._id,
                topicName,
                parameterName: pName,
                deviceName: r.deviceName,
                address: r.address,
                scaleFactor: sfNum,
                decimal: decVal
              }
              if (r.unit && String(r.unit).trim() !== '') {
                tagData.unit = String(r.unit).trim()
              }

              if (existingTag) {
                if (existingTag.latestValue !== null && existingTag.latestValue !== undefined) {
                  const isNone = decVal === null || decVal === undefined || String(decVal).toLowerCase() === 'none' || Number(decVal) === 0
                  let newStr
                  if (!isNone && !isNaN(Number(decVal)) && Number(decVal) > 0) {
                    const d = parseInt(decVal, 10)
                    const num = Number(existingTag.latestValue)
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
                    newStr = `${sign}${intPart}.${fracPart}`
                  } else {
                    newStr = String(Math.trunc(Number(existingTag.latestValue)))
                  }
                  tagData.latestValueStr = newStr
                  if (io) {
                    const evt = {
                      tagId: existingTag._id.toString(),
                      telemetryTopic: existingTag.telemetryTopic,
                      value: existingTag.latestValue,
                      valueStr: newStr,
                      valStr: newStr,
                      arrivedAt: (existingTag.latestArrivedAt || new Date()).toISOString(),
                      todayMax: existingTag.todayMax,
                      yesterdayMax: existingTag.yesterdayMax,
                      weekMax: existingTag.weekMax
                    }
                    io.to('admins').emit('telemetry:reading', evt)
                    io.to(`company:${company._id}`).emit('telemetry:reading', evt)
                    if (existingTag.assignedEmployeeIds && existingTag.assignedEmployeeIds.length > 0) {
                      existingTag.assignedEmployeeIds.forEach(empId => {
                        io.to(`employee:${empId.toString()}`).emit('telemetry:reading', evt)
                      })
                    }
                  }
                }
                await TelemetryTag.updateOne({ _id: existingTag._id }, { $set: tagData })
              } else {
                tagData.telemetryTopic = defaultTelemetryTopic
                await TelemetryTag.create(tagData)
              }
            }

            // Parameter Cascade Cleanup: reconcile orphans/duplicates against published config
            try {
              const cleanupResult = await reconcileGatewayTags(gateway._id, req.app.locals)
              const removedCount = cleanupResult.orphanTagIds.length + cleanupResult.duplicateTagIds.length
              if (removedCount > 0) {
                console.log(`[ParameterCleanup] Removed ${cleanupResult.orphanTagIds.length} orphan + ${cleanupResult.duplicateTagIds.length} duplicate tags across ${cleanupResult.affectedUserIds.length} users`)
              }
            } catch (cleanupErr) {
              console.error('[ParameterCleanup] Error during deleted parameter cascade cleanup:', cleanupErr.message)
            }

            if (io) {
              io.to(`company:${company._id}`).emit('gateway:config-publish-status', {
                configId: config._id.toString(),
                gatewayId: gateway._id.toString(),
                status: 'pending',
                groupCount
              })
              io.to('admins').emit('gateway:config-publish-status', {
                configId: config._id.toString(),
                gatewayId: gateway._id.toString(),
                status: 'pending',
                groupCount
              })
            }
          } else {
            config.publishStatus = 'failed'
            config.publishError = publishErrors.join('; ')
            await config.save()
            if (io) {
              io.to(`company:${company._id}`).emit('gateway:config-publish-status', {
                configId: config._id.toString(),
                gatewayId: gateway._id.toString(),
                status: 'failed',
                error: config.publishError
              })
              io.to('admins').emit('gateway:config-publish-status', {
                configId: config._id.toString(),
                gatewayId: gateway._id.toString(),
                status: 'failed',
                error: config.publishError
              })
            }
          }
        }
      })
    }

    res.json({ success: true, config, groupCount })
  } catch (error) {
    next(error)
  }
})

// Delete group by stable groupNum (supports ?dbOnly=true to skip MQTT publish)
router.delete(['/:gatewayId/config/group/:groupNum', '/:gatewayId/groups/:groupNum'], async (req, res, next) => {
  try {
    const groupNum = parseInt(req.params.groupNum, 10)
    const isDbOnly = req.query.dbOnly === 'true' || req.body?.dbOnly === true
    if (isNaN(groupNum) || groupNum < 1) throw createError(400, 'Invalid group number')

    await checkGatewayPermission(req.user, req.params.gatewayId, 'configureModbus')

    const gateway = await Gateway.findById(req.params.gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    const mqttClient = req.app.locals.mqttClient
    if (!isDbOnly && (!mqttClient || !mqttClient.connected)) {
      throw createError(503, 'MQTT Broker disconnected. Cannot send delete command.')
    }

    // Get latest config and verify target group exists
    const latestConfig = await GatewayConfig.findOne({ gatewayId: gateway._id }).sort({ createdAt: -1 })
    if (!latestConfig) throw createError(404, 'No config found for this gateway')

    const targetGroup = (latestConfig.groups || []).find(g => g.groupNum === groupNum)
    if (!targetGroup) {
      throw createError(404, `Group G${groupNum} not found in gateway configuration`)
    }

    const deletedGroupRows = targetGroup.rows || []

    if (!isDbOnly) {
      // 1. Publish delete command FIRST to MQTT broker: {prefix}/Setconfig/G{n}/Del
      const mqttTopic = `${gateway.prefix}/Setconfig/G${groupNum}/Del`
      await new Promise((resolve, reject) => {
        mqttClient.publish(mqttTopic, '1', { qos: 1 }, (err) => {
          if (err) {
            console.error(`[MQTT] Failed to publish delete for G${groupNum}:`, err.message)
            return reject(createError(500, `MQTT publish failed: ${err.message}`))
          }
          console.log(`[MQTT] Delete command sent for G${groupNum} to ${mqttTopic}`)
          resolve()
        })
      })
    }

    // 2. Remove group from groups array and update config DB record
    const updatedGroups = (latestConfig.groups || []).filter(g => g.groupNum !== groupNum)
    const allRows = updatedGroups.flatMap(g => g.rows || [])
    const fullPayload = allRows.length > 0 ? generateMqttPayload(allRows) : ' '

    const existingDeletes = (latestConfig.pendingBoardDeletes || []).filter(d => d.groupNum !== groupNum)
    const newPendingDeletes = isDbOnly ? existingDeletes : [
      ...existingDeletes,
      { groupNum, deletedAt: new Date() }
    ]

    const updatedConfig = await GatewayConfig.create({
      companyId: latestConfig.companyId,
      gatewayId: gateway._id,
      rows: allRows,
      groups: updatedGroups,
      payload: fullPayload,
      groupCount: updatedGroups.length,
      publishStatus: latestConfig.publishStatus,
      publishedAt: latestConfig.publishedAt,
      pendingBoardDeletes: newPendingDeletes,
      createdBy: req.user._id
    })

    // 3. Execute Group Level Cascade Cleanup (unassigns users, removes tags & readings, recalculates assigned gateways)
    const cleanupResult = await cleanupGroupCascade(gateway._id, deletedGroupRows, req.app.locals)

    logActivity({
      user: req.user,
      companyId: gateway.companyId,
      action: 'DELETE_CONFIG_GROUP',
      category: 'Gateway',
      details: `Deleted Group G${groupNum} (DB Only: ${isDbOnly}) from gateway "${gateway.name}" (${gateway.prefix}) - Cleaned ${cleanupResult.tagIds.length} tags across ${cleanupResult.affectedUserIds.length} users`,
      req
    })

    res.json({ success: true, groupNum, dbOnly: isDbOnly, pendingBoardDeletes: newPendingDeletes, config: updatedConfig, cleanedTagsCount: cleanupResult.tagIds.length })
  } catch (error) {
    next(error)
  }
})

// Read active Modbus configuration from gateway (per-group)
router.post('/:gatewayId/read-config', async (req, res, next) => {
  try {
    await checkGatewayPermission(req.user, req.params.gatewayId, 'readConfig')
    const gateway = await Gateway.findById(req.params.gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    const mqttClient = req.app.locals.mqttClient
    if (!mqttClient || !mqttClient.connected) {
      throw createError(503, 'MQTT Broker disconnected. Cannot publish read trigger.')
    }

    logActivity({
      user: req.user,
      companyId: gateway.companyId,
      action: 'TRIGGER_READ_CONFIG',
      category: 'Gateway',
      details: `Triggered Read Config (G1..G20) for gateway "${gateway.name}" (${gateway.prefix})`,
      req
    })

    // Always query at least 20 groups (G1 to G20) so all board-side groups are fetched
    let groupCount = Math.max(parseInt(req.body.groupCount, 10) || 20, 20)

    const io = req.app.locals.io
    const gwId = gateway._id.toString()

    if (!io.configReadExpectations) {
      io.configReadExpectations = new Map()
    }

    const existing = io.configReadExpectations.get(gwId)
    if (existing) {
      clearTimeout(existing.timer)
      io.configReadExpectations.delete(gwId)
    }

    io.configReadExpectations.set(gwId, {
      groupCount,
      received: new Set(),
      payloads: new Map(),
      timer: setTimeout(() => {
        const exp = io.configReadExpectations.get(gwId)
        if (!exp) return
        io.configReadExpectations.delete(gwId)
        if (exp.received.size > 0) {
          const groupPayloads = []
          const sortedRec = Array.from(exp.received).sort((a, b) => a - b)
          for (const g of sortedRec) {
            const p = exp.payloads.get(g)
            if (p) {
              let raw = p.trim()
              if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).trim()
              if (raw) groupPayloads.push(raw)
            }
          }
          const mergedPayload = groupPayloads.join(';')
          io.to(`company:${gateway.companyId}`).emit('gateway:config-response', {
            gatewayId: gwId,
            prefix: gateway.prefix,
            payload: mergedPayload,
            groupCount: exp.received.size,
            partial: exp.received.size < groupCount,
            receivedGroups: sortedRec
          })
          io.to('admins').emit('gateway:config-response', {
            gatewayId: gwId,
            prefix: gateway.prefix,
            payload: mergedPayload,
            groupCount: exp.received.size,
            partial: exp.received.size < groupCount,
            receivedGroups: sortedRec
          })
        }
      }, 10000)
    })

    for (let g = 1; g <= groupCount; g++) {
      const topic = `${gateway.prefix}/Readconfig/G${g}`
      mqttClient.publish(topic, '1', { qos: 1 })
      console.log(`[MQTT] Published Readconfig trigger to ${topic}`)
    }

    res.json({ success: true, message: `Read config triggers sent for ${groupCount} group(s)`, groupCount })
  } catch (error) {
    next(error)
  }
})

// Read WiFi/system status from gateway
router.post('/:gatewayId/wifi-status', async (req, res, next) => {
  try {
    const gateway = await Gateway.findById(req.params.gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    const mqttClient = req.app.locals.mqttClient
    if (!mqttClient || !mqttClient.connected) {
      throw createError(503, 'MQTT Broker disconnected. Cannot publish WiFi status query.')
    }

    const topic = `${gateway.prefix}/Wifi`
    mqttClient.publish(topic, '1', { qos: 1 })
    console.log(`[MQTT] Published WiFi status trigger to ${topic}`)

    res.json({ success: true, message: 'WiFi status query trigger sent to gateway' })
  } catch (error) {
    next(error)
  }
})


// Set location on gateway via MQTT
router.post('/:gatewayId/set-location-mqtt', async (req, res, next) => {
  try {
    const { location } = req.body
    const gateway = await Gateway.findById(req.params.gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    const mqttClient = req.app.locals.mqttClient
    if (!mqttClient || !mqttClient.connected) {
      throw createError(503, 'MQTT Broker disconnected. Cannot publish location change.')
    }

    const payloadLoc = String(location || '').trim().substring(0, 30)
    const topic = `${gateway.prefix}/SetLocation`
    mqttClient.publish(topic, payloadLoc, { qos: 1 })
    console.log(`[MQTT] Published SetLocation: ${payloadLoc} to ${topic}`)

    res.json({ success: true, message: 'Set Location trigger sent to gateway' })
  } catch (error) {
    next(error)
  }
})

// Update gateway device list mapping
router.put('/:gatewayId/devices', async (req, res, next) => {
  try {
    const { devices } = req.body
    if (!Array.isArray(devices)) {
      throw createError(400, 'Devices must be an array')
    }

    const normalizedDevices = []
    const seenSlaves = new Set()
    const seenNames = new Set()
    for (let i = 0; i < devices.length; i++) {
      const d = devices[i]
      const rawName = d.deviceName ? String(d.deviceName).trim() : ''
      if (!rawName) {
        throw createError(400, `Device row ${i + 1}: Device Name is required`)
      }
      if (/\s/.test(rawName)) {
        throw createError(400, `Device row ${i + 1}: Device Name "${rawName}" cannot contain spaces`)
      }
      if (seenNames.has(rawName)) {
        throw createError(400, `Duplicate Device Name "${rawName}". Each device must have a unique name.`)
      }
      seenNames.add(rawName)

      const sid = Number(d.slaveId)
      if (isNaN(sid) || sid < 1 || sid > 247) {
        throw createError(400, `Device row ${i + 1}: Slave ID must be between 1 and 247`)
      }
      if (seenSlaves.has(sid)) {
        throw createError(400, `Duplicate Slave ID ${sid} in Device List. Each device must have a unique Slave ID.`)
      }
      seenSlaves.add(sid)

      const br = normalizeBaudRate(d.baudRate)
      const sc = d.serialConfig ? String(d.serialConfig).trim() : '8N1'

      normalizedDevices.push({
        slaveId: sid,
        deviceName: rawName,
        baudRate: br,
        serialConfig: sc
      })
    }

    const gateway = await Gateway.findByIdAndUpdate(
      req.params.gatewayId,
      { devices: normalizedDevices },
      { new: true }
    )
    if (!gateway) throw createError(404, 'Gateway not found')

    res.json({ success: true, gateway, devices: gateway.devices })
  } catch (error) {
    next(error)
  }
})

// Read location details from gateway via MQTT
router.post('/:gatewayId/read-location-details', async (req, res, next) => {
  try {
    const gateway = await Gateway.findById(req.params.gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    const mqttClient = req.app.locals.mqttClient
    if (!mqttClient || !mqttClient.connected) {
      throw createError(503, 'MQTT Broker disconnected. Cannot publish location details query.')
    }

    const topic = `${gateway.prefix}/ReadLocationdetails`
    mqttClient.publish(topic, '1', { qos: 1 })
    console.log(`[MQTT] Published ReadLocationdetails query to ${topic}`)

    res.json({ success: true, message: 'Read Location details query sent to gateway' })
  } catch (error) {
    next(error)
  }
})

// Set delay interval on gateway via MQTT
router.post('/:gatewayId/set-delay-mqtt', async (req, res, next) => {
  try {
    const { delay } = req.body
    const delayNum = Number(delay)
    if (isNaN(delayNum) || !Number.isInteger(delayNum) || delayNum < 1 || delayNum > 600) {
      throw createError(400, 'Publish interval must be a whole number between 1 and 600 seconds.')
    }
    const gateway = await Gateway.findById(req.params.gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    const mqttClient = req.app.locals.mqttClient
    if (!mqttClient || !mqttClient.connected) {
      throw createError(503, 'MQTT Broker disconnected. Cannot publish delay change.')
    }

    const topic = `${gateway.prefix}/Delay`
    mqttClient.publish(topic, String(delayNum), { qos: 1 })
    console.log(`[MQTT] Published Delay: ${delayNum} to ${topic}`)

    gateway.publishInterval = delayNum
    if (!gateway.lastWifiStatus) gateway.lastWifiStatus = {}
    gateway.lastWifiStatus.delay = String(delayNum)
    await gateway.save()

    res.json({ success: true, message: 'Set Delay trigger sent to gateway' })
  } catch (error) {
    next(error)
  }
})

// Read delay details from gateway via MQTT
router.post('/:gatewayId/read-delay-details', async (req, res, next) => {
  try {
    const gateway = await Gateway.findById(req.params.gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    const mqttClient = req.app.locals.mqttClient
    if (!mqttClient || !mqttClient.connected) {
      throw createError(503, 'MQTT Broker disconnected. Cannot publish delay details query.')
    }

    const topic = `${gateway.prefix}/Delaydetails`
    mqttClient.publish(topic, '1', { qos: 1 })
    console.log(`[MQTT] Published Delaydetails query to ${topic}`)

    res.json({ success: true, message: 'Read Delay details query sent to gateway' })
  } catch (error) {
    next(error)
  }
})

// Upload FOTA binary as base64 string
router.post('/:gatewayId/fota/upload', async (req, res, next) => {
  try {
    const { filename, base64Data } = req.body
    if (!filename || !base64Data) {
      throw createError(400, 'filename and base64Data are required')
    }

    const dataBuffer = Buffer.from(base64Data, 'base64')
    const firmware = new Firmware({
      filename,
      data: dataBuffer,
      contentType: 'application/octet-stream'
    })
    await firmware.save()

    const downloadUrl = `${req.protocol}://${req.get('host')}/api/fota/download/${firmware._id}`
    console.log(`[FOTA] Uploaded ${filename} successfully. Generated URL: ${downloadUrl}`)

    res.json({ success: true, downloadUrl, id: firmware._id })
  } catch (error) {
    next(error)
  }
})

// Trigger FOTA update on gateway via MQTT
router.post('/:gatewayId/fota/trigger', async (req, res, next) => {
  try {
    const { downloadUrl } = req.body
    const gateway = await Gateway.findById(req.params.gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    const mqttClient = req.app.locals.mqttClient
    if (!mqttClient || !mqttClient.connected) {
      throw createError(503, 'MQTT Broker disconnected. Cannot publish FOTA update request.')
    }

    const topic = `${gateway.prefix}/FOTA`
    mqttClient.publish(topic, String(downloadUrl), { qos: 1 })
    console.log(`[MQTT] Published FOTA trigger to ${topic} with link: ${downloadUrl}`)

    res.json({ success: true, message: 'FOTA update request sent to gateway' })
  } catch (error) {
    next(error)
  }
})




// Test gateway status by publishing to {prefix}/Test and waiting for {prefix}/Test/res
router.post('/:gatewayId/test-status', async (req, res, next) => {
  try {
    const gateway = await Gateway.findById(req.params.gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    const mqttClient = req.app.locals.mqttClient
    if (!mqttClient || !mqttClient.connected) {
      throw createError(503, 'MQTT Broker disconnected. Cannot publish test query.')
    }

    const prefix = gateway.prefix
    const publishTopic = `${prefix}/Test`
    const responseTopic = `${prefix}/Test/res`

    // Ensure we are subscribed to the response topic
    mqttClient.subscribe(responseTopic)

    // Return a promise that resolves when response arrives
    let myResolve
    const waitPromise = new Promise((resolve) => {
      myResolve = resolve
      if (!mqttClient.pendingTests.has(prefix)) {
        mqttClient.pendingTests.set(prefix, [])
      }
      mqttClient.pendingTests.get(prefix).push(resolve)
    })

    mqttClient.publish(publishTopic, '1', { qos: 1 })
    console.log(`[MQTT] Published Test query to ${publishTopic}`)

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        resolve(null)
      }, 10000)
    })

    const result = await Promise.race([waitPromise, timeoutPromise])

    // Cleanup pending resolver
    const resolvers = mqttClient.pendingTests.get(prefix)
    if (resolvers) {
      const idx = resolvers.indexOf(myResolve)
      if (idx !== -1) resolvers.splice(idx, 1)
      if (resolvers.length === 0) {
        mqttClient.pendingTests.delete(prefix)
      }
    }

    if (result !== null) {
      gateway.status = 'online'
      gateway.lastSeenAt = new Date()
      await gateway.save()
      res.json({ success: true, status: 'online' })
    } else {
      gateway.status = 'offline'
      await gateway.save()
      res.json({ success: true, status: 'offline' })
    }
  } catch (error) {
    next(error)
  }
})

// Check gateway version by publishing to {prefix}/Version and waiting for {prefix}/Version/res
router.post('/:gatewayId/check-version', async (req, res, next) => {
  try {
    const gateway = await Gateway.findById(req.params.gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    const mqttClient = req.app.locals.mqttClient
    if (!mqttClient || !mqttClient.connected) {
      throw createError(503, 'MQTT Broker disconnected. Cannot publish version query.')
    }

    const prefix = gateway.prefix
    const publishTopic = `${prefix}/Version`
    const responseTopic = `${prefix}/Version/res`

    // Ensure we are subscribed to the response topic
    mqttClient.subscribe(responseTopic)

    // Return a promise that resolves when response arrives
    let myResolve
    const waitPromise = new Promise((resolve) => {
      myResolve = resolve
      if (!mqttClient.pendingVersions.has(prefix)) {
        mqttClient.pendingVersions.set(prefix, [])
      }
      mqttClient.pendingVersions.get(prefix).push(resolve)
    })

    mqttClient.publish(publishTopic, '1', { qos: 1 })
    console.log(`[MQTT] Published Version query to ${publishTopic}`)

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        resolve(null)
      }, 10000)
    })

    const result = await Promise.race([waitPromise, timeoutPromise])

    // Cleanup pending resolver
    const resolvers = mqttClient.pendingVersions.get(prefix)
    if (resolvers) {
      const idx = resolvers.indexOf(myResolve)
      if (idx !== -1) resolvers.splice(idx, 1)
      if (resolvers.length === 0) {
        mqttClient.pendingVersions.delete(prefix)
      }
    }

    if (result !== null) {
      const versionString = result.trim() || 'Unknown'
      gateway.version = versionString
      gateway.lastSeenAt = new Date()
      await gateway.save()
      res.json({ success: true, version: versionString })
    } else {
      res.json({ success: false, message: 'Timeout waiting for gateway version response' })
    }
  } catch (error) {
    next(error)
  }
})

// Trigger GPS location fetch from gateway via MQTT
router.post('/:gatewayId/gps-location', async (req, res, next) => {
  try {
    const gateway = await Gateway.findById(req.params.gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    const mqttClient = req.app.locals.mqttClient
    if (!mqttClient || !mqttClient.connected) {
      throw createError(503, 'MQTT Broker disconnected. Cannot publish GPS query.')
    }

    const prefix = gateway.prefix
    const publishTopic = `${prefix}/GPS`
    const responseTopic = `${prefix}/GPS/res`

    mqttClient.subscribe(responseTopic)

    let myResolve
    const waitPromise = new Promise((resolve) => {
      myResolve = resolve
      if (!mqttClient.pendingGPS.has(prefix)) {
        mqttClient.pendingGPS.set(prefix, [])
      }
      mqttClient.pendingGPS.get(prefix).push(resolve)
    })

    mqttClient.publish(publishTopic, '1', { qos: 1 })
    console.log(`[MQTT] Published GPS query to ${publishTopic}`)

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve(null), 10000)
    })

    const result = await Promise.race([waitPromise, timeoutPromise])

    const resolvers = mqttClient.pendingGPS.get(prefix)
    if (resolvers) {
      const idx = resolvers.indexOf(myResolve)
      if (idx !== -1) resolvers.splice(idx, 1)
      if (resolvers.length === 0) mqttClient.pendingGPS.delete(prefix)
    }

    if (result !== null) {
      const [latStr, lngStr] = result.split(',').map(s => s.trim())
      const lat = parseFloat(latStr)
      const lng = parseFloat(lngStr)
      if (!isNaN(lat) && !isNaN(lng)) {
        gateway.gps = { lat, lng, updatedAt: new Date() }
        gateway.lastSeenAt = new Date()
        await gateway.save()
        return res.json({ success: true, gps: { lat, lng } })
      }
    }
    res.json({ success: false, message: 'GPS location request timeout or invalid response' })
  } catch (error) {
    next(error)
  }
})

// Test-All: Trigger both status test and version check in parallel
router.post('/:gatewayId/test-all', async (req, res, next) => {
  try {
    const gateway = await Gateway.findById(req.params.gatewayId)
    if (!gateway) throw createError(404, 'Gateway not found')

    const mqttClient = req.app.locals.mqttClient
    if (!mqttClient || !mqttClient.connected) {
      throw createError(503, 'MQTT Broker disconnected. Cannot publish test queries.')
    }

    const prefix = gateway.prefix
    const testPublishTopic = `${prefix}/Test`
    const testResponseTopic = `${prefix}/Test/res`
    const verPublishTopic = `${prefix}/Version`
    const verResponseTopic = `${prefix}/Version/res`

    // Ensure we are subscribed to both response topics
    mqttClient.subscribe([testResponseTopic, verResponseTopic])

    // 1. Setup Status test promise
    let testResolve
    const statusPromise = new Promise((resolve) => {
      testResolve = resolve
      if (!mqttClient.pendingTests.has(prefix)) {
        mqttClient.pendingTests.set(prefix, [])
      }
      mqttClient.pendingTests.get(prefix).push(resolve)
    })

    // 2. Setup Version check promise
    let verResolve
    const versionPromise = new Promise((resolve) => {
      verResolve = resolve
      if (!mqttClient.pendingVersions.has(prefix)) {
        mqttClient.pendingVersions.set(prefix, [])
      }
      mqttClient.pendingVersions.get(prefix).push(resolve)
    })

    // Publish both messages
    mqttClient.publish(testPublishTopic, '1', { qos: 1 })
    mqttClient.publish(verPublishTopic, '1', { qos: 1 })
    console.log(`[MQTT] Published test-all queries to ${prefix}`)

    // Setup 10-second timeout
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        resolve(null)
      }, 10000)
    })

    // We race each individual promise with the timeout promise
    const [statusResult, versionResult] = await Promise.all([
      Promise.race([statusPromise, timeoutPromise]),
      Promise.race([versionPromise, timeoutPromise])
    ])

    // Cleanup pending resolvers
    const testResolvers = mqttClient.pendingTests.get(prefix)
    if (testResolvers) {
      const idx = testResolvers.indexOf(testResolve)
      if (idx !== -1) testResolvers.splice(idx, 1)
      if (testResolvers.length === 0) mqttClient.pendingTests.delete(prefix)
    }

    const verResolvers = mqttClient.pendingVersions.get(prefix)
    if (verResolvers) {
      const idx = verResolvers.indexOf(verResolve)
      if (idx !== -1) verResolvers.splice(idx, 1)
      if (verResolvers.length === 0) mqttClient.pendingVersions.delete(prefix)
    }

    // Update Gateway Document
    if (statusResult !== null) {
      gateway.status = 'online'
      gateway.lastSeenAt = new Date()
    } else {
      gateway.status = 'offline'
    }

    if (versionResult !== null) {
      gateway.version = versionResult.trim() || 'Unknown'
      gateway.lastSeenAt = new Date()
    }

    await gateway.save()

    res.json({
      success: true,
      status: gateway.status,
      version: gateway.version,
      statusSuccess: statusResult !== null,
      versionSuccess: versionResult !== null
    })
  } catch (error) {
    next(error)
  }
})

module.exports = router
