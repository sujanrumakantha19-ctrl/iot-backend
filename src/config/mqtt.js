const mqtt = require('mqtt')
const fs = require('fs')
const path = require('path')
const Gateway = require('../models/Gateway')
const TelemetryTag = require('../models/TelemetryTag')
const TelemetryReading = require('../models/TelemetryReading')
const Company = require('../models/Company')
const influx = require('../services/influx')
const Firmware = require('../models/Firmware')
const User = require('../models/User')
const emailService = require('../services/emailService')

const caCert = fs.readFileSync(path.join(__dirname, '../../certs/ca.crt'))

/**
 * Helper to evaluate thresholds and send email alerts
 */
async function evaluateThresholdAlerts(tag, value, company, gateway) {
  try {
    if (tag.alertsEnabled === false) return

    const warning = tag.warningThreshold
    const critical = tag.criticalThreshold

    if (warning === null && critical === null) return

    let severity = null
    if (critical !== null && value >= critical) {
      severity = 'critical'
    } else if (warning !== null && value >= warning) {
      severity = 'warning'
    }

    const now = new Date()
    const COOLDOWN_MS = 15 * 60 * 1000 // 15 minutes cooldown

    if (severity) {
      const isCritical = severity === 'critical'
      const lastSentField = isCritical ? 'lastCriticalAlertSentAt' : 'lastWarningAlertSentAt'
      const lastSent = tag[lastSentField] ? new Date(tag[lastSentField]).getTime() : 0
      const timeDiff = now.getTime() - lastSent

      const stateChanged = tag.lastAlertState !== severity

      if (stateChanged || timeDiff >= COOLDOWN_MS) {
        const tagDoc = await TelemetryTag.findById(tag._id)
          .populate('assignedEmployeeIds', 'email managerId name')
          .populate('companyId', 'name')
          .populate('gatewayId', 'name prefix')
          .lean()

        if (!tagDoc) return

        const assignedEmps = tagDoc.assignedEmployeeIds || []
        const recipientEmails = []

        assignedEmps.forEach(e => {
          if (e.email) recipientEmails.push(e.email)
        })

        const managerIds = []
        assignedEmps.forEach(e => {
          if (Array.isArray(e.managerId)) {
            e.managerId.forEach(m => managerIds.push(m))
          } else if (e.managerId) {
            managerIds.push(e.managerId)
          }
        })

        const managers = await User.find({
          $or: [
            { _id: { $in: managerIds } },
            { companyId: tagDoc.companyId?._id || tagDoc.companyId, role: 'manager' }
          ]
        }, 'email').lean()

        managers.forEach(m => {
          if (m.email) recipientEmails.push(m.email)
        })

        if (recipientEmails.length > 0) {
          emailService.sendThresholdAlertEmail({
            tag: tagDoc,
            value,
            severity,
            recipientEmails,
            companyName: tagDoc.companyId?.name || company?.name,
            gatewayName: tagDoc.gatewayId?.name || gateway?.name
          })

          await TelemetryTag.findByIdAndUpdate(tag._id, {
            [lastSentField]: now,
            lastAlertState: severity
          })
        }
      }
    } else {
      if (tag.lastAlertState && tag.lastAlertState !== 'normal') {
        await TelemetryTag.findByIdAndUpdate(tag._id, { lastAlertState: 'normal' })
      }
    }
  } catch (err) {
    console.error('[MQTT] Threshold evaluation error (safe catch):', err.message)
  }
}

/**
 * Compute scaled and decimal-formatted telemetry value
 */
function computeTelemetryValue(rawVal, scaleFactor = 1, decimal = 'None') {
  if (rawVal === null || rawVal === undefined) return null
  const rawStr = String(rawVal).trim()
  if (!rawStr) return null
  const raw = parseFloat(rawStr)
  if (isNaN(raw)) return null
  const sf = (scaleFactor !== null && scaleFactor !== undefined && !isNaN(Number(scaleFactor))) ? Number(scaleFactor) : 1

  const scaled = raw * sf
  let valueStr

  const isNone = decimal === null || decimal === undefined || String(decimal).toLowerCase() === 'none' || Number(decimal) === 0

  if (!isNone && !isNaN(Number(decimal)) && Number(decimal) > 0) {
    const d = parseInt(decimal, 10)
    const sign = scaled < 0 ? '-' : ''
    const absStr = Math.abs(scaled).toString()
    const parts = absStr.split('.')
    const intPart = parts[0]
    let fracPart = parts[1] || ''
    if (fracPart.length < d) {
      fracPart = fracPart.padEnd(d, '0')
    } else {
      fracPart = fracPart.slice(0, d)
    }
    valueStr = `${sign}${intPart}.${fracPart}`
  } else {
    // 'None' = 0 decimal places, TRUNCATE (not round). 76.98 → "76", NOT "77"
    valueStr = String(Math.trunc(scaled))
  }
  const value = parseFloat(valueStr)
  return { value, valueStr }
}

/**
 * Process offline buffered telemetry sent to {Gatewayprefix}/backup
 * Payload format: "2026-09-07T06:07:20.000+00:00,P1,15,15,15,P2,2713,2713,..."
 * Timestamps calculated backwards from baseTime using gateway publish interval.
 */
async function processGatewayBackupPayload(gateway, rawPayload, io) {
  if (!rawPayload || !gateway) return

  let clean = rawPayload.trim()
  if (clean.startsWith('"') && clean.endsWith('"')) {
    clean = clean.slice(1, -1).trim()
  }
  if (clean.startsWith('{') && clean.endsWith('}')) {
    clean = clean.slice(1, -1).trim()
  }
  if (!clean) return

  const tokens = clean.split(',').map(t => t.trim()).filter(Boolean)
  if (tokens.length < 2) {
    console.warn(`[MQTT-Backup] Insufficient tokens in backup payload for gateway ${gateway.prefix}`)
    return
  }

  // Token 0: Base timestamp (T0)
  const baseTimeStr = tokens[0]
  let baseTime = new Date(baseTimeStr)
  if (isNaN(baseTime.getTime())) {
    baseTime = new Date(baseTimeStr.replace(/"/g, ''))
  }
  if (isNaN(baseTime.getTime())) {
    console.warn(`[MQTT-Backup] Unparseable base timestamp "${baseTimeStr}" for gateway ${gateway.prefix}, fallback to now`)
    baseTime = new Date()
  }
  const baseTimeMs = baseTime.getTime()

  // Fetch all TelemetryTags for this gateway
  const tags = await TelemetryTag.find({ gatewayId: gateway._id })
    .select('companyId gatewayId parameterName topicName displayName deviceName unit telemetryTopic scaleFactor decimal latestArrivedAt')
    .lean()

  if (!tags || tags.length === 0) {
    console.warn(`[MQTT-Backup] No TelemetryTags found in DB for gateway ${gateway.name} (${gateway.prefix})`)
    return
  }

  const tagMap = {}
  for (const tag of tags) {
    if (tag.parameterName) {
      tagMap[tag.parameterName.toLowerCase()] = tag
      tagMap[tag.parameterName.replace(/^[tp](\d+)$/i, 'P$1').toLowerCase()] = tag
      const m = tag.parameterName.match(/^[tp]0*(\d+)$/i)
      if (m) tagMap[`p${m[1]}`] = tag
    }
    if (tag.topicName) {
      tagMap[tag.topicName.toLowerCase()] = tag
      tagMap[tag.topicName.replace(/^[tp](\d+)$/i, 'P$1').toLowerCase()] = tag
      const m = tag.topicName.match(/^[tp]0*(\d+)$/i)
      if (m) tagMap[`p${m[1]}`] = tag
    }
    if (tag.displayName) tagMap[tag.displayName.toLowerCase()] = tag
  }

  // Group tokens: Token 0 was baseTime; subsequent are parameters followed by their numeric readings
  const paramGroups = []
  let currentGroup = null

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]
    const tokLower = tok.toLowerCase()
    const normKey = tok.replace(/^[tp](\d+)$/i, 'P$1').toLowerCase()

    const isParam = tagMap[tokLower] ||
      tagMap[normKey] ||
      /^[tp]\d+$/i.test(tok) ||
      (isNaN(Number(tok)) && /^[a-zA-Z][a-zA-Z0-9_]*$/i.test(tok) && !['nan', 'null', 'undefined'].includes(tokLower))

    if (isParam) {
      currentGroup = { paramName: tok, values: [] }
      paramGroups.push(currentGroup)
    } else if (currentGroup) {
      currentGroup.values.push(tok)
    }
  }

  if (paramGroups.length === 0) {
    console.warn(`[MQTT-Backup] No parameters recognized in backup payload for gateway ${gateway.prefix}`)
    return
  }

  // Determine gateway publish interval (seconds -> ms)
  let intervalSec = gateway.publishInterval || parseInt(gateway.lastWifiStatus?.delay, 10) || 5
  if (isNaN(intervalSec) || intervalSec <= 0) intervalSec = 5
  const intervalMs = intervalSec * 1000

  let gatewayConfigRows = null
  const readingDocs = []
  const tagUpdates = []

  for (const group of paramGroups) {
    const pLower = group.paramName.toLowerCase()
    const pNorm = group.paramName.replace(/^[tp](\d+)$/i, 'P$1').toLowerCase()
    const m = group.paramName.match(/^[tp]0*(\d+)$/i)
    const pStrip = m ? `p${m[1]}` : pLower

    const tag = tagMap[pLower] || tagMap[pNorm] || tagMap[pStrip]
    if (!tag) {
      continue
    }

    let sf = tag.scaleFactor
    let dec = tag.decimal

    if (sf === undefined || sf === null || dec === undefined || dec === null) {
      if (!gatewayConfigRows) {
        try {
          const GatewayConfig = require('../models/GatewayConfig')
          const latestCfg = await GatewayConfig.findOne({ gatewayId: gateway._id }).sort({ createdAt: -1 }).lean()
          gatewayConfigRows = latestCfg?.rows?.length
            ? latestCfg.rows
            : (latestCfg?.groups || []).flatMap(g => g.rows || [])
        } catch (_) {
          gatewayConfigRows = []
        }
      }
      const matchedRow = (gatewayConfigRows || []).find(r =>
        (r.parameterName && r.parameterName.toLowerCase() === pLower) ||
        (r.topicName && r.topicName.toLowerCase() === pLower)
      )
      if (matchedRow) {
        sf = (matchedRow.scaleFactor !== undefined && matchedRow.scaleFactor !== null && !isNaN(Number(matchedRow.scaleFactor))) ? Number(matchedRow.scaleFactor) : 1
        dec = (matchedRow.decimal !== undefined && matchedRow.decimal !== null && String(matchedRow.decimal).toLowerCase() !== 'none') ? Number(matchedRow.decimal) : 'None'
      } else {
        sf = sf ?? 1
        dec = dec ?? 'None'
      }
    }

    const numValues = group.values.length
    if (numValues === 0) continue

    // Convention: Oldest -> Newest (chronological order)
    // Last value (index = numValues - 1) is at baseTimeMs (T0)
    // Value at index i is at T0 - (numValues - 1 - i) * intervalMs
    let latestComputed = null
    let latestTime = null

    for (let i = 0; i < numValues; i++) {
      const rawVal = group.values[i]
      const computed = computeTelemetryValue(rawVal, sf, dec)
      if (!computed) continue

      const pointTimeMs = baseTimeMs - (numValues - 1 - i) * intervalMs
      const pointDate = new Date(pointTimeMs)

      readingDocs.push({
        companyId: tag.companyId,
        gatewayId: tag.gatewayId,
        tagId: tag._id,
        telemetryTopic: tag.telemetryTopic || `${gateway.prefix}/${tag.parameterName.toLowerCase()}`,
        value: computed.value,
        valueStr: computed.valueStr,
        arrivedAt: pointDate
      })

      latestComputed = computed
      latestTime = pointDate
    }

    // Only update tag.latestValue if this batch point is newer than current latestArrivedAt
    if (latestComputed && latestTime) {
      const currentLatestTime = tag.latestArrivedAt ? new Date(tag.latestArrivedAt).getTime() : 0
      if (latestTime.getTime() > currentLatestTime) {
        tagUpdates.push({
          updateOne: {
            filter: { _id: tag._id },
            update: {
              $set: {
                latestValue: latestComputed.value,
                latestValueStr: latestComputed.valueStr,
                latestArrivedAt: latestTime
              }
            }
          }
        })
      }
    }
  }

  if (readingDocs.length > 0) {
    // 1. Insert into MongoDB
    await TelemetryReading.insertMany(readingDocs, { ordered: false }).catch(err => {
      console.warn('[MQTT-Backup] TelemetryReading insertMany warning:', err.message)
    })

    // 2. Write into InfluxDB
    try {
      for (const doc of readingDocs) {
        influx.writeReading(doc)
      }
      await influx.flush()
    } catch (influxErr) {
      console.warn('[MQTT-Backup] InfluxDB write/flush error:', influxErr.message)
    }

    // 3. Update TelemetryTag latestValue if applicable
    if (tagUpdates.length > 0) {
      await TelemetryTag.bulkWrite(tagUpdates).catch(err => {
        console.warn('[MQTT-Backup] TelemetryTag bulkWrite warning:', err.message)
      })
    }

    // 4. Update Gateway lastSeenAt
    await Gateway.findByIdAndUpdate(gateway._id, { lastSeenAt: new Date() })

    console.log(`[MQTT-Backup] Successfully processed ${readingDocs.length} historical backup readings across ${paramGroups.length} parameters for gateway "${gateway.name}" (${gateway.prefix}) at base time ${baseTime.toISOString()}`)

    // 5. Emit socket event
    if (io) {
      io.to(`company:${gateway.companyId}`).emit('telemetry:backup-processed', {
        gatewayId: gateway._id.toString(),
        prefix: gateway.prefix,
        recordCount: readingDocs.length,
        baseTime: baseTime.toISOString()
      })
      io.to('admins').emit('telemetry:backup-processed', {
        gatewayId: gateway._id.toString(),
        prefix: gateway.prefix,
        recordCount: readingDocs.length,
        baseTime: baseTime.toISOString()
      })
    }
  }
}

const connectMQTT = (io) => {
  const client = mqtt.connect(process.env.MQTT_BROKER_URL, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    ca: caCert,
    rejectUnauthorized: true,
    checkServerIdentity: () => undefined,
    keepalive: 60,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  })

  client.pendingTests = new Map()
  client.pendingVersions = new Map()
  client.pendingGPS = new Map()

  // Subscription helper for gateway specific topics (Data, Config responses, Wifi responses, Test/Version checks)
  client.subscribeToGatewayTopics = (prefix) => {
    const topics = [
      `${prefix}/Data`,
      `${prefix}/Timestamp`,
      `${prefix}/timestamp`,
      `${prefix}/Readconfig/Res`,
      `${prefix}/Readconfig/+/res`,
      `${prefix}/Wifi/res`,
      `${prefix}/Test/res`,
      `${prefix}/Version/res`,
      `${prefix}/ReadLocationdetails/res`,
      `${prefix}/Delaydetails/res`,
      `${prefix}/FOTA/res`,
      `${prefix}/GPS`,
      `${prefix}/GPS/res`,
      `${prefix}/Setconfig/+/Ack`,
      `${prefix}/Setconfig/+/Del/Ack`,
      `${prefix}/Setconfig/Ack`,
      `${prefix}/Setconfig/+/ack`,
      `${prefix}/Setconfig/+/Del/ack`,
      `${prefix}/Setconfig/ack`,
      `${prefix}/backup`,
      `${prefix}/Backup`
    ]
    client.subscribe(topics, (err) => {
      if (err) console.error(`[MQTT] Sub error for gateway topics (${prefix}):`, err.message)
      else console.log(`[MQTT] Subscribed to target gateway topics for: ${prefix}`)
    })
  }

  // Unsubscription helper for gateway specific topics
  client.unsubscribeFromGatewayTopics = (prefix) => {
    const topics = [
      `${prefix}/Data`,
      `${prefix}/Timestamp`,
      `${prefix}/timestamp`,
      `${prefix}/Readconfig/Res`,
      `${prefix}/Readconfig/+/res`,
      `${prefix}/Wifi/res`,
      `${prefix}/Test/res`,
      `${prefix}/Version/res`,
      `${prefix}/ReadLocationdetails/res`,
      `${prefix}/Delaydetails/res`,
      `${prefix}/FOTA/res`,
      `${prefix}/GPS`,
      `${prefix}/GPS/res`,
      `${prefix}/Setconfig/+/Ack`,
      `${prefix}/Setconfig/+/Del/Ack`,
      `${prefix}/Setconfig/Ack`,
      `${prefix}/Setconfig/+/ack`,
      `${prefix}/Setconfig/+/Del/ack`,
      `${prefix}/Setconfig/ack`,
      `${prefix}/backup`,
      `${prefix}/Backup`
    ]
    client.unsubscribe(topics, (err) => {
      if (err) console.error(`[MQTT] Unsub error for gateway topics (${prefix}):`, err.message)
      else console.log(`[MQTT] Unsubscribed from target gateway topics for: ${prefix}`)
    })
  }

  // Subscription helper for company telemetry scope
  client.subscribeToCompanyTelemetry = (slug) => {
    const topic = `${slug}/#`
    client.subscribe(topic, (err) => {
      if (err) console.error(`[MQTT] Sub error for company telemetry (${slug}):`, err.message)
      else console.log(`[MQTT] Subscribed to targeted company telemetry scope: ${topic}`)
    })
  }

  // Unsubscription helper for company telemetry scope
  client.unsubscribeFromCompanyTelemetry = (slug) => {
    const topic = `${slug}/#`
    client.unsubscribe(topic, (err) => {
      if (err) console.error(`[MQTT] Unsub error for company telemetry (${slug}):`, err.message)
      else console.log(`[MQTT] Unsubscribed from targeted company telemetry scope: ${topic}`)
    })
  }

  client.on('connect', async () => {
    console.log('MQTT connected to broker:', process.env.MQTT_BROKER_URL)

    // Automatic subscription for timestamp request topics across all gateways (special case: Sarayu/Timestamp)
    const timestampBootTopics = [
      'Sarayu/Timestamp',
      'sarayu/Timestamp',
      'Sarayu/timestamp',
      'sarayu/timestamp',
      'Sarayu/Timestamp/req',
      'sarayu/Timestamp/req',
      '+/Timestamp',
      '+/timestamp',
      '+/+/Timestamp',
      '+/+/timestamp',
      '+/Timestamp/req',
      '+/timestamp/req',
      '+/backup',
      '+/Backup'
    ]
    client.subscribe(timestampBootTopics, (err) => {
      if (err) console.error('[MQTT] Error subscribing to boot Timestamp topics:', err.message)
      else console.log('[MQTT] Successfully subscribed on boot to Timestamp request topics:', timestampBootTopics)
    })

    // Fetch and subscribe to all registered company scopes
    try {
      const companies = await Company.find({}, { slug: 1 })
      console.log(`[MQTT] Boot subscribing to telemetry scopes for ${companies.length} companies...`)
      companies.forEach(company => {
        if (company.slug) {
          client.subscribeToCompanyTelemetry(company.slug)
        }
      })
    } catch (err) {
      console.error('[MQTT] Error fetching companies for boot subscription:', err.message)
    }

    // Fetch and subscribe all existing gateways on boot/reconnect
    try {
      const gateways = await Gateway.find({}, { prefix: 1 })
      console.log(`[MQTT] Boot subscribing to target topics for ${gateways.length} gateways...`)
      gateways.forEach(gw => {
        if (gw.prefix) {
          client.subscribeToGatewayTopics(gw.prefix)
        }
      })
    } catch (err) {
      console.error('[MQTT] Error fetching gateways for boot subscription:', err.message)
    }
  })

  const emitConfigResponse = (gwId, prefix, payload, groupCount, partial) => {
    const eventData = {
      gatewayId: gwId,
      prefix,
      payload,
      groupCount: groupCount || 1,
      partial: !!partial
    }
    console.log('[MQTT] emitConfigResponse — gwId:', gwId, 'prefix:', prefix, 'groupCount:', groupCount, 'partial:', partial)

    Gateway.findById(gwId).then(gateway => {
      if (!gateway) {
        console.warn('[MQTT] emitConfigResponse — gateway not found:', gwId)
        return
      }
      console.log('[MQTT] emitting gateway:config-response to company:', gateway.companyId)
      io.to(`company:${gateway.companyId}`).emit('gateway:config-response', eventData)
      io.to('admins').emit('gateway:config-response', eventData)
    }).catch(err => {
      console.error('[MQTT] Error emitting config response:', err.message)
    })
  }

  const mergeGroupPayloads = (expectation) => {
    let merged = ''
    for (let g = 1; g <= expectation.groupCount; g++) {
      const p = expectation.payloads.get(g)
      if (p) {
        let trimmed = p.trim()
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
          trimmed = trimmed.slice(1, -1).trim()
        }
        if (trimmed) {
          if (merged && !merged.endsWith(';') && !trimmed.startsWith(';')) {
            merged += ';'
          }
          merged += trimmed
        }
      }
    }
    return merged
  }

  client.on('message', async (topic, payload) => {
    const rawPayload = payload.toString()

    try {
      const parts = topic.split('/')
      console.log('[MQTT] topic parts:', parts)

      // Special Case: Auto Timestamp request (Sarayu/Timestamp -> Sarayu/Timestamp/res)
      const topicLower = topic.toLowerCase()
      const isResponseTopic = topicLower.endsWith('/res') || topicLower.endsWith('/ack')

      if (!isResponseTopic && (topicLower === 'sarayu/timestamp' || topicLower === 'sarayu/timestamp/req' || topicLower.endsWith('/timestamp') || topicLower.endsWith('/timestamp/req'))) {
        const isReq = topicLower.endsWith('/timestamp/req')
        const prefix = parts.slice(0, parts.length - (isReq ? 2 : 1)).join('/')
        const resTopic = prefix.toLowerCase() === 'sarayu' ? 'Sarayu/Timestamp/res' : `${prefix}/Timestamp/res`

        // Format UTC timestamp: %Y-%m-%dT%H:%M:%S.000+00:00
        const now = new Date()
        const year = now.getUTCFullYear()
        const month = String(now.getUTCMonth() + 1).padStart(2, '0')
        const day = String(now.getUTCDate()).padStart(2, '0')
        const hours = String(now.getUTCHours()).padStart(2, '0')
        const minutes = String(now.getUTCMinutes()).padStart(2, '0')
        const seconds = String(now.getUTCSeconds()).padStart(2, '0')
        const millis = String(now.getUTCMilliseconds()).padStart(3, '0')

        const formattedTimestamp = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${millis}+00:00`

        client.publish(resTopic, formattedTimestamp, { qos: 0 }, (err) => {
          if (err) {
            console.error(`[MQTT] Timestamp publish error to ${resTopic}:`, err.message)
          } else {
            console.log(`[MQTT] Auto-responded live timestamp to ${resTopic}: ${formattedTimestamp}`)
          }
        })
        return
      }

      // Case: Test response -> prefix/Test/res
      if (parts[1] === 'Test' && parts[2]?.toLowerCase() === 'res') {
        const prefix = parts[0]
        console.log(`[MQTT] Test response arrived for prefix ${prefix}`)
        const resolvers = client.pendingTests.get(prefix)
        if (resolvers) {
          resolvers.forEach(resolve => resolve(rawPayload))
          client.pendingTests.delete(prefix)
        }
        return
      }

      // Case: Version response -> prefix/Version/res
      if (parts[1] === 'Version' && parts[2]?.toLowerCase() === 'res') {
        const prefix = parts[0]
        console.log(`[MQTT] Version response arrived for prefix ${prefix}: ${rawPayload}`)
        const resolvers = client.pendingVersions.get(prefix)
        if (resolvers) {
          resolvers.forEach(resolve => resolve(rawPayload))
          client.pendingVersions.delete(prefix)
        }
        return
      }

      // Case 1: Readconfig response (per-group: prefix/Readconfig/G{n}/res, legacy: prefix/Readconfig/Res)
      if (parts[1] === 'Readconfig' && (parts[3]?.toLowerCase() === 'res' || parts[2]?.toLowerCase() === 'res')) {
        console.log('[MQTT] matched Readconfig response handler')
        const prefix = parts[0]
        const gateway = await Gateway.findOne({ prefix })
        console.log('[MQTT] gateway lookup by prefix:', prefix, 'found:', !!gateway)
        if (!gateway) return

        const gwId = gateway._id.toString()

        // Extract group number from parts[2] (e.g. "G1" → 1)
        const groupMatch = parts[2]?.match(/^G(\d+)$/i)
        console.log('[MQTT] groupMatch result:', groupMatch)
        if (groupMatch) {
          const groupNum = parseInt(groupMatch[1], 10)
          console.log('[MQTT] groupNum:', groupNum)
          const expectations = io.configReadExpectations
          const expectation = expectations ? expectations.get(gwId) : null
          console.log('[MQTT] expectation found:', !!expectation, 'gwId:', gwId)

          if (expectation) {
            // Store per-group response
            expectation.received.add(groupNum)
            expectation.payloads.set(groupNum, rawPayload)
            console.log('[MQTT] stored group payload — received:', [...expectation.received], 'of', expectation.groupCount)

            // Also persist individual group payload to gateway document
            gateway.lastConfigPayload = {
              payload: rawPayload,
              updatedAt: new Date()
            }
            gateway.lastSeenAt = new Date()
            await gateway.save()

            // Emit per-group progress
            console.log('[MQTT] emitting gateway:config-group-response for group', groupNum)
            io.to(`company:${gateway.companyId}`).emit('gateway:config-group-response', {
              gatewayId: gwId,
              prefix,
              groupNum,
              groupCount: expectation.groupCount,
              payload: rawPayload
            })
            io.to('admins').emit('gateway:config-group-response', {
              gatewayId: gwId,
              prefix,
              groupNum,
              groupCount: expectation.groupCount,
              payload: rawPayload
            })

            // Check if all groups received
            if (expectation.received.size >= expectation.groupCount) {
              console.log('[MQTT] all groups received, merging...')
              clearTimeout(expectation.timer)
              expectations.delete(gwId)

              const mergedPayload = mergeGroupPayloads(expectation)
              console.log('[MQTT] merged payload:', mergedPayload)
              gateway.lastConfigPayload = {
                payload: mergedPayload,
                updatedAt: new Date()
              }
              await gateway.save()

              emitConfigResponse(gwId, prefix, mergedPayload, expectation.groupCount, false)
            }
          } else {
            console.log('[MQTT] no pending expectation — emitting as single-group response')
            // No pending expectation — still store and emit as a single-group response
            gateway.lastConfigPayload = {
              payload: rawPayload,
              updatedAt: new Date()
            }
            gateway.lastSeenAt = new Date()
            await gateway.save()

            emitConfigResponse(gwId, prefix, rawPayload, 1, false)
          }
        } else {
          console.log('[MQTT] no group number in topic — treating as single-group response')
          // No group number — treat as single-group response
          gateway.lastConfigPayload = {
            payload: rawPayload,
            updatedAt: new Date()
          }
          gateway.lastSeenAt = new Date()
          await gateway.save()

          emitConfigResponse(gwId, prefix, rawPayload, 1, false)
        }
        return
      }

      // Case 2: Wifi status response -> prefix/Wifi/res
      if (parts[1] === 'Wifi' && parts[2]?.toLowerCase() === 'res') {
        const prefix = parts[0]
        const gateway = await Gateway.findOne({ prefix })
        if (!gateway) return

        let wifiObj = { ssid: '', rssi: '', ipAddress: '', delay: '', updatedAt: new Date() }
        if (rawPayload.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(rawPayload)
            wifiObj.ssid = parsed.ssid || ''
            wifiObj.rssi = String(parsed.rssi || '')
            wifiObj.ipAddress = parsed.ipAddress || parsed.ip || ''
            wifiObj.delay = String(parsed.delay || '')
          } catch (e) {}
        } else {
          const chunks = rawPayload.split(',')
          wifiObj.ssid = chunks[0]?.trim() || ''
          wifiObj.rssi = chunks[1]?.trim() || ''
          wifiObj.ipAddress = chunks[2]?.trim() || ''
          wifiObj.delay = chunks[3]?.trim() || ''
        }

        gateway.lastWifiStatus = wifiObj
        gateway.lastSeenAt = new Date()
        await gateway.save()

        io.to(`company:${gateway.companyId}`).emit('gateway:wifi-response', {
          gatewayId: gateway._id.toString(),
          prefix,
          payload: rawPayload
        })
        io.to('admins').emit('gateway:wifi-response', {
          gatewayId: gateway._id.toString(),
          prefix,
          payload: rawPayload
        })
        return
      }
      // Case 3: Location response -> prefix/ReadLocationdetails/res
      if (parts[1] === 'ReadLocationdetails' && parts[2]?.toLowerCase() === 'res') {
        const prefix = parts[0]
        const gateway = await Gateway.findOne({ prefix })
        if (!gateway) return

        if (rawPayload && rawPayload.trim()) {
          gateway.location = rawPayload.trim().substring(0, 30)
          gateway.lastSeenAt = new Date()
          await gateway.save()
        }

        io.to(`company:${gateway.companyId}`).emit('gateway:location-response', {
          gatewayId: gateway._id.toString(),
          prefix,
          payload: rawPayload
        })
        io.to('admins').emit('gateway:location-response', {
          gatewayId: gateway._id.toString(),
          prefix,
          payload: rawPayload
        })
        return
      }
      // Case 3.5: Delay response -> prefix/Delaydetails/res
      if (parts[1] === 'Delaydetails' && parts[2]?.toLowerCase() === 'res') {
        const prefix = parts[0]
        const gateway = await Gateway.findOne({ prefix })
        if (!gateway) return

        if (rawPayload && rawPayload.trim()) {
          const delayNum = parseInt(rawPayload.trim(), 10)
          if (!isNaN(delayNum) && delayNum > 0) {
            gateway.publishInterval = delayNum
            if (!gateway.lastWifiStatus) gateway.lastWifiStatus = {}
            gateway.lastWifiStatus.delay = String(delayNum)
            await gateway.save()
          }
        }

        io.to(`company:${gateway.companyId}`).emit('gateway:delay-response', {
          gatewayId: gateway._id.toString(),
          prefix,
          payload: rawPayload
        })
        io.to('admins').emit('gateway:delay-response', {
          gatewayId: gateway._id.toString(),
          prefix,
          payload: rawPayload
        })
        return
      }

      // Case 3.7: FOTA response -> prefix/FOTA/res
      if (parts[1] === 'FOTA' && parts[2]?.toLowerCase() === 'res') {
        const prefix = parts[0]
        const gateway = await Gateway.findOne({ prefix })
        if (!gateway) return

        const status = rawPayload.trim() // '1' (success) or '0' (failure)
        console.log(`[MQTT] FOTA response received for gateway ${prefix}: ${status}`)

        // Delete latest firmware document from MongoDB as instructed
        try {
          const lastFirmware = await Firmware.findOne().sort({ createdAt: -1 })
          if (lastFirmware) {
            await Firmware.findByIdAndDelete(lastFirmware._id)
            console.log(`[FOTA] Automatically deleted firmware file ${lastFirmware.filename} from DB`)
          }
        } catch (e) {
          console.error('[FOTA] Failed to auto-delete firmware file:', e.message)
        }

        io.to(`company:${gateway.companyId}`).emit('gateway:fota-response', {
          gatewayId: gateway._id.toString(),
          prefix,
          payload: status
        })
        io.to('admins').emit('gateway:fota-response', {
          gatewayId: gateway._id.toString(),
          prefix,
          payload: status
        })
        return
      }

      // Case 3.9: GPS response -> prefix/GPS/res
      if (parts[1] === 'GPS' && parts[2]?.toLowerCase() === 'res') {
        const prefix = parts[0]
        console.log(`[MQTT] GPS response arrived for prefix ${prefix}: ${rawPayload}`)
        const resolvers = client.pendingGPS.get(prefix)
        if (resolvers) {
          resolvers.forEach(resolve => resolve(rawPayload))
          client.pendingGPS.delete(prefix)
        }
        const [latStr, lngStr] = rawPayload.split(',').map(s => s.trim())
        const lat = parseFloat(latStr)
        const lng = parseFloat(lngStr)
        if (!isNaN(lat) && !isNaN(lng)) {
          const gateway = await Gateway.findOne({ prefix })
          if (gateway) {
            gateway.gps = { lat, lng, updatedAt: new Date() }
            gateway.lastSeenAt = new Date()
            await gateway.save()
            io.to('admins').emit('gateway:gps-response', {
              gatewayId: gateway._id.toString(),
              prefix,
              gps: { lat, lng }
            })
            io.to(`company:${gateway.companyId}`).emit('gateway:gps-response', {
              gatewayId: gateway._id.toString(),
              prefix,
              gps: { lat, lng }
            })
          }
        }
        return
      }

      // Case 3.95a: Publish ACK -> prefix/Setconfig/G{n}/ack
      // Topic parts: [prefix, 'Setconfig', 'G{n}', 'ack'] (length = 4)
      if (
        parts[1]?.toLowerCase() === 'setconfig' &&
        parts.length === 4 &&
        parts[3]?.toLowerCase() === 'ack' &&
        /^G\d+$/i.test(parts[2])
      ) {
        const prefix = parts[0]
        const groupNum = parseInt(parts[2].slice(1), 10)   // 'G2' -> 2
        console.log(`[MQTT] Publish ACK for G${groupNum} on prefix ${prefix}: topic=${topic}`)
        const gateway = await Gateway.findOne({ prefix })
        if (gateway) {
          const gwId = gateway._id.toString()
          try {
            const GatewayConfig = require('../models/GatewayConfig')
            const latestConfig = await GatewayConfig.findOne({ gatewayId: gateway._id }).sort({ createdAt: -1 })
            if (latestConfig) {
              // Mark specific group as success
              let allSuccess = true
              for (const g of latestConfig.groups) {
                if (g.groupNum === groupNum) {
                  g.publishStatus = 'success'
                  g.publishedAt = new Date()
                }
                if (g.groupNum !== groupNum && g.publishStatus !== 'success') allSuccess = false
              }
              // Overall config status: success only if ALL groups ACK'd
              if (allSuccess) {
                latestConfig.publishStatus = 'success'
                latestConfig.publishedAt = new Date()
              }
              await latestConfig.save()
              console.log(`[MQTT] Persisted G${groupNum} publishStatus: success in DB for ${prefix}`)
            }
          } catch (e) {
            console.error('[MQTT] Failed to update group publish status in DB:', e.message)
          }
          const payload = { gatewayId: gwId, prefix, topic, groupNum }
          io.to(`company:${gateway.companyId}`).emit('gateway:setconfig-ack', payload)
          io.to('admins').emit('gateway:setconfig-ack', payload)
        }
        return
      }

      // Case 3.95b: Delete ACK -> prefix/Setconfig/G{n}/Del/ack
      // Topic parts: [prefix, 'Setconfig', 'G{n}', 'Del', 'ack'] (length = 5)
      if (
        parts[1]?.toLowerCase() === 'setconfig' &&
        parts.length === 5 &&
        parts[4]?.toLowerCase() === 'ack' &&
        parts[3]?.toLowerCase() === 'del' &&
        /^G\d+$/i.test(parts[2])
      ) {
        const prefix = parts[0]
        const groupNum = parseInt(parts[2].slice(1), 10)
        console.log(`[MQTT] Delete ACK for G${groupNum} on prefix ${prefix}: topic=${topic}`)
        const gateway = await Gateway.findOne({ prefix })
        if (gateway) {
          const gwId = gateway._id.toString()
          try {
            const GatewayConfig = require('../models/GatewayConfig')
            // Remove groupNum from pendingBoardDeletes in latest config
            await GatewayConfig.findOneAndUpdate(
              { gatewayId: gateway._id },
              { $pull: { pendingBoardDeletes: { groupNum } } },
              { sort: { createdAt: -1 } }
            )
            console.log(`[MQTT] Cleared G${groupNum} from pendingBoardDeletes for ${prefix}`)
          } catch (e) {
            console.error('[MQTT] Failed to clear pendingBoardDeletes:', e.message)
          }
          const payload = { gatewayId: gwId, prefix, topic, groupNum }
          io.to(`company:${gateway.companyId}`).emit('gateway:setconfig-delete-ack', payload)
          io.to('admins').emit('gateway:setconfig-delete-ack', payload)
        }
        return
      }

      // Case 3.98: Gateway Backup Telemetry -> prefix/backup or prefix/Backup
      if (parts[parts.length - 1]?.toLowerCase() === 'backup' && parts.length >= 2) {
        const prefix = parts.slice(0, parts.length - 1).join('/')
        let gateway = await Gateway.findOne({ prefix })
        if (!gateway) {
          gateway = await Gateway.findOne({ prefix: new RegExp('^' + prefix + '$', 'i') })
        }
        if (!gateway && parts.length > 2) {
          const shortPrefix = parts[parts.length - 2]
          gateway = await Gateway.findOne({ prefix: shortPrefix }) ||
            await Gateway.findOne({ prefix: new RegExp('^' + shortPrefix + '$', 'i') })
        }
        if (!gateway) {
          console.warn(`[MQTT-Backup] Backup data received for unknown gateway prefix: ${prefix}`)
          return
        }
        await processGatewayBackupPayload(gateway, rawPayload, io)
        return
      }

      // Case 4: Bulk telemetry reading -> gatewayPrefix/Data
      if (parts[1] === 'Data' && parts.length === 2) {
        const prefix = parts[0]
        // console.log(`[MQTT] Bulk Data received on topic: ${topic} with payload: ${rawPayload}`)
        
        const gateway = await Gateway.findOne({ prefix })
        if (!gateway) {
          console.warn(`[MQTT] Bulk Data received for unknown gateway prefix: ${prefix}`)
          return
        }

        let cleanPayload = rawPayload.trim()
        if (cleanPayload.startsWith('{') && cleanPayload.endsWith('}')) {
          cleanPayload = cleanPayload.slice(1, -1)
        }
        cleanPayload = cleanPayload.trim()
        if (!cleanPayload) {
          console.warn('[MQTT] Bulk Data payload is empty or malformed')
          return
        }

        const entries = cleanPayload.split(';')
        const parsedData = {}
        for (const entry of entries) {
          const trimmed = entry.trim()
          if (!trimmed) continue
          const pair = trimmed.split(',')
          if (pair.length < 2) continue
          const key = pair[0].trim().toLowerCase()
          const valStr = pair[1].trim()
          parsedData[key] = { rawVal: valStr }
        }

        // console.log('[MQTT] Parsed parameters from payload:', parsedData)

        const tags = await TelemetryTag.find({ gatewayId: gateway._id })
          .select('companyId gatewayId parameterName topicName displayName deviceName unit telemetryTopic assignedEmployeeIds warningThreshold criticalThreshold alertsEnabled lastWarningAlertSentAt lastCriticalAlertSentAt lastAlertState todayMax yesterdayMax weekMax scaleFactor decimal')
          .lean()
        if (!tags || tags.length === 0) {
          console.warn(`[MQTT] No TelemetryTags found in DB for gateway: ${gateway.name} (${prefix})`)
          return
        }

        // console.log(`[MQTT] Loaded ${tags.length} configured tags for this gateway:`, tags.map(t => `${t.parameterName} (${t.telemetryTopic})`))

        const tagMap = {}
        for (const tag of tags) {
          if (tag.parameterName) tagMap[tag.parameterName.toLowerCase()] = tag
          if (tag.topicName) tagMap[tag.topicName.toLowerCase()] = tag
          if (tag.displayName) tagMap[tag.displayName.toLowerCase()] = tag
          if (tag.telemetryTopic) {
            const seg = tag.telemetryTopic.split('/').pop()
            if (seg) tagMap[seg.toLowerCase()] = tag
          }
        }

        const now = new Date()

        const readingDocs = []
        const tagUpdates = []
        const socketEvents = []
        let gatewayConfigRows = null

        for (const [paramName, item] of Object.entries(parsedData)) {
          const tag = tagMap[paramName]
          if (!tag) {
            // console.log(`[MQTT] Parameter "${paramName}" ignored (no tag configuration found for this gateway)`)
            continue
          }

          let sf = tag.scaleFactor
          let dec = tag.decimal

          if (sf === undefined || sf === null || dec === undefined || dec === null) {
            if (!gatewayConfigRows) {
              try {
                const GatewayConfig = require('../models/GatewayConfig')
                const latestCfg = await GatewayConfig.findOne({ gatewayId: gateway._id }).sort({ createdAt: -1 }).lean()
                gatewayConfigRows = latestCfg?.rows?.length ? latestCfg.rows : (latestCfg?.groups || []).flatMap(g => g.rows || [])
              } catch (_) {
                gatewayConfigRows = []
              }
            }
            const matchedRow = (gatewayConfigRows || []).find(r =>
              (r.parameterName && r.parameterName.toLowerCase() === paramName) ||
              (r.topicName && r.topicName.toLowerCase() === paramName) ||
              (tag.parameterName && r.parameterName && r.parameterName.toLowerCase() === tag.parameterName.toLowerCase()) ||
              (tag.address != null && r.address === tag.address)
            )
            if (matchedRow) {
              sf = (matchedRow.scaleFactor !== undefined && matchedRow.scaleFactor !== null && !isNaN(Number(matchedRow.scaleFactor))) ? Number(matchedRow.scaleFactor) : 1
              dec = (matchedRow.decimal !== undefined && matchedRow.decimal !== null && String(matchedRow.decimal).toLowerCase() !== 'none') ? Number(matchedRow.decimal) : 'None'
              tag.scaleFactor = sf
              tag.decimal = dec
              TelemetryTag.updateOne({ _id: tag._id }, { $set: { scaleFactor: sf, decimal: dec } }).catch(() => {})
            }
          }

          const computed = computeTelemetryValue(item.rawVal, sf, dec)
          if (!computed) continue
          const { value, valueStr } = computed

          // Trigger non-blocking threshold alert checks
          evaluateThresholdAlerts(tag, value, null, gateway).catch(err => console.error('[MQTT] Threshold eval error:', err.message))

          const tagIdStr = tag._id.toString()
          const currentTodayMax = (tag.todayMax !== null && tag.todayMax !== undefined && !isNaN(tag.todayMax)) ? tag.todayMax : -Infinity
          const currentWeekMax = (tag.weekMax !== null && tag.weekMax !== undefined && !isNaN(tag.weekMax)) ? tag.weekMax : -Infinity
          const yesterdayMax = tag.yesterdayMax ?? 0

          const todayMax = Math.max(currentTodayMax === -Infinity ? value : currentTodayMax, value)
          const weekMax = Math.max(currentWeekMax === -Infinity ? value : currentWeekMax, value)

          // console.log(`[MQTT] Matched parameter "${paramName}" -> Tag Topic: "${tag.telemetryTopic}" | Value: ${value} (${valueStr}) | Today Max: ${todayMax}`)

          const eventData = {
            tagId: tagIdStr,
            telemetryTopic: tag.telemetryTopic,
            value,
            valueStr,
            valStr: valueStr,
            arrivedAt: now.toISOString(),
            todayMax,
            yesterdayMax,
            weekMax,
            decimal: dec
          }

          socketEvents.push({ tag, eventData })

          readingDocs.push({
            companyId: tag.companyId,
            gatewayId: tag.gatewayId,
            tagId: tag._id,
            telemetryTopic: tag.telemetryTopic,
            value,
            valueStr,
            arrivedAt: now
          })

          tagUpdates.push({
            updateOne: {
              filter: { _id: tag._id },
              update: { $set: { latestValue: value, latestValueStr: valueStr, latestArrivedAt: now, todayMax, yesterdayMax, weekMax } }
            }
          })
        }

        // 1. Emit to socket immediately (non-blocking)
        socketEvents.forEach(({ tag, eventData }) => {
          io.to('admins').emit('telemetry:reading', eventData)
          io.to(`company:${tag.companyId}`).emit('telemetry:reading', eventData)
          if (tag.assignedEmployeeIds && tag.assignedEmployeeIds.length > 0) {
            tag.assignedEmployeeIds.forEach(empId => {
              io.to(`employee:${empId.toString()}`).emit('telemetry:reading', eventData)
            })
          }
        })

        // 2. Persist in background (non-blocking)
        if (readingDocs.length > 0) {
          Promise.all([
            TelemetryTag.bulkWrite(tagUpdates),
            Gateway.findByIdAndUpdate(gateway._id, { lastSeenAt: now }),
            TelemetryReading.insertMany(readingDocs, { ordered: false }).catch(err => {
              console.warn('[MQTT] TelemetryReading insertMany warning:', err.message)
            }),
            (async () => {
              for (const doc of readingDocs) {
                influx.writeReading({
                  ...doc,
                  tagId: doc.tagId ? doc.tagId.toString() : '',
                  companyId: doc.companyId ? doc.companyId.toString() : '',
                  gatewayId: doc.gatewayId ? doc.gatewayId.toString() : ''
                })
              }
              await influx.flush()
            })()
          ]).then(() => {
            // console.log(`[MQTT] Successfully saved ${readingDocs.length} readings and updated latestValues in DB.`)
          }).catch(err => {
            console.error('[MQTT] Bulk Data DB write error:', err.message)
          })
        } else {
          console.warn('[MQTT] No matched tag readings to save to database')
        }
        return
      }

      // Case 3: Telemetry reading -> companySlug/gatewayPrefix/topicName
      if (parts.length >= 3) {
        const tag = await TelemetryTag.findOne({ telemetryTopic: topic })
          .select('companyId gatewayId _id telemetryTopic assignedEmployeeIds scaleFactor decimal')
          .lean()
        if (!tag) return

        const computed = computeTelemetryValue(rawPayload, tag.scaleFactor, tag.decimal)
        if (!computed) return
        const { value, valueStr } = computed

        const arrivedAt = new Date()

        const currentTodayMax = (tag.todayMax !== null && tag.todayMax !== undefined && !isNaN(tag.todayMax)) ? tag.todayMax : -Infinity
        const currentWeekMax = (tag.weekMax !== null && tag.weekMax !== undefined && !isNaN(tag.weekMax)) ? tag.weekMax : -Infinity
        const yesterdayMax = tag.yesterdayMax ?? 0

        const todayMax = Math.max(currentTodayMax === -Infinity ? value : currentTodayMax, value)
        const weekMax = Math.max(currentWeekMax === -Infinity ? value : currentWeekMax, value)

        await TelemetryTag.updateOne(
          { _id: tag._id },
          { $set: { latestValue: value, latestValueStr: valueStr, latestArrivedAt: arrivedAt, todayMax, yesterdayMax, weekMax } }
        )

        await Gateway.findByIdAndUpdate(tag.gatewayId, { lastSeenAt: arrivedAt })

        TelemetryReading.create({
          companyId: tag.companyId,
          gatewayId: tag.gatewayId,
          tagId: tag._id,
          telemetryTopic: topic,
          value,
          valueStr,
          arrivedAt
        }).catch(() => {})

        influx.writeReading({
          companyId: tag.companyId.toString(),
          gatewayId: tag.gatewayId.toString(),
          tagId: tag._id.toString(),
          value,
          valueStr,
          arrivedAt
        })
        await influx.flush()

        const eventData = {
          tagId: tag._id.toString(),
          telemetryTopic: topic,
          value,
          valueStr,
          valStr: valueStr,
          arrivedAt: arrivedAt.toISOString(),
          todayMax,
          yesterdayMax,
          weekMax,
          decimal: tag.decimal
        }

        io.to('admins').emit('telemetry:reading', eventData)
        io.to(`company:${tag.companyId}`).emit('telemetry:reading', eventData)

        if (tag.assignedEmployeeIds && tag.assignedEmployeeIds.length > 0) {
          tag.assignedEmployeeIds.forEach(empId => {
            io.to(`employee:${empId.toString()}`).emit('telemetry:reading', eventData)
          })
        }
      }
    } catch (err) {
      console.error('[MQTT] Message routing error:', err.message)
    }
  })

  client.on('error', (err) => {
    console.error('[MQTT] Connection error:', err.message)
  })

  return client
}

module.exports = connectMQTT
