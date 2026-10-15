const { InfluxDB, Point } = require('@influxdata/influxdb-client')

const url = process.env.INFLUXDB_URL || 'http://localhost:8086'
const token = process.env.INFLUXDB_TOKEN || 'iot-token-sarayu-2026'
const org = process.env.INFLUXDB_ORG || 'iotorg'
const bucket = process.env.INFLUXDB_BUCKET || 'iotbucket'

const influxDB = new InfluxDB({ url, token })
const writeApi = influxDB.getWriteApi(org, bucket, 'ms')
const queryApi = influxDB.getQueryApi(org)

function writeReading({ tagId, companyId, gatewayId, value, arrivedAt }) {
  const num = Number(value)
  if (isNaN(num)) return
  const point = new Point('telemetry_reading')
    .tag('tagId', String(tagId))
    .tag('companyId', String(companyId || ''))
    .tag('gatewayId', String(gatewayId || ''))
    .floatField('value', num)
    .timestamp(arrivedAt ? new Date(arrivedAt) : new Date())
  writeApi.writePoint(point)
}

async function flush() {
  await writeApi.flush()
}

function fluxBound(val, defaultVal = 'now()') {
  if (!val) return defaultVal
  const str = String(val).trim()
  if (str === 'now()' || str.startsWith('-')) {
    return str
  }
  const d = new Date(str)
  if (!isNaN(d.getTime())) {
    return `time(v: "${d.toISOString()}")`
  }
  return str
}

async function queryReadings({ tagId, startDate, endDate, limit = 10000 }) {
  const start = fluxBound(startDate, '-30d')
  const stop = fluxBound(endDate, 'now()')
  const fluxQuery = `from(bucket: "${bucket}")
    |> range(start: ${start}, stop: ${stop})
    |> filter(fn: (r) => r._measurement == "telemetry_reading" and r.tagId == "${String(tagId)}")
    |> filter(fn: (r) => r._field == "value")
    |> sort(columns: ["_time"], desc: false)
    |> limit(n: ${limit})`

  const result = []
  try {
    for await (const { values, tableMeta } of queryApi.iterateRows(fluxQuery)) {
      const row = tableMeta.toObject(values)
      result.push({
        _id: row._time,
        value: row._value,
        arrivedAt: row._time,
        tagId: row.tagId
      })
    }
  } catch (err) {
    console.error('[Influx Query Error] queryReadings failed:', err.message, '| Query:', fluxQuery)
  }

  // Fallback to MongoDB TelemetryReading if Influx returns 0 readings
  if (result.length === 0 && tagId) {
    try {
      const TelemetryReading = require('../models/TelemetryReading')
      const mongoFilter = { tagId }
      if (startDate || endDate) {
        mongoFilter.arrivedAt = {}
        if (startDate) {
          const d = new Date(startDate)
          if (!isNaN(d.getTime())) {
            mongoFilter.arrivedAt.$gte = d
          } else {
            mongoFilter.arrivedAt.$gte = new Date(Date.now() - 30 * 60 * 1000)
          }
        }
        if (endDate) {
          const d = new Date(endDate)
          if (!isNaN(d.getTime())) mongoFilter.arrivedAt.$lte = d
        }
      }
      const mongoDocs = await TelemetryReading.find(mongoFilter)
        .sort({ arrivedAt: 1 })
        .limit(limit)
        .lean()
      if (mongoDocs.length > 0) {
        return mongoDocs.map(r => ({
          _id: r._id.toString(),
          value: r.value,
          arrivedAt: r.arrivedAt ? new Date(r.arrivedAt).toISOString() : new Date().toISOString(),
          tagId: r.tagId.toString()
        }))
      }
    } catch (_) {}
  }

  return result
}

async function queryReadingsInTags({ tagIds, startDate, endDate, limit = 10000, skip = 0 }) {
  if (!tagIds || tagIds.length === 0) return []
  const start = fluxBound(startDate, '-30d')
  const stop = fluxBound(endDate, 'now()')
  const tagFilter = tagIds.map(id => `r.tagId == "${id}"`).join(' or ')
  const fluxQuery = `from(bucket: "${bucket}")
    |> range(start: ${start}, stop: ${stop})
    |> filter(fn: (r) => r._measurement == "telemetry_reading" and (${tagFilter}))
    |> filter(fn: (r) => r._field == "value")
    |> sort(columns: ["_time"], desc: true)
    |> limit(n: ${limit + skip})`

  const allRows = []
  try {
    for await (const { values, tableMeta } of queryApi.iterateRows(fluxQuery)) {
      const row = tableMeta.toObject(values)
      allRows.push({
        _id: row._time,
        value: row._value,
        arrivedAt: row._time,
        tagId: row.tagId
      })
    }
  } catch (err) {
    console.error('[Influx Query Error] queryReadingsInTags failed:', err.message, '| Query:', fluxQuery)
  }
  return skip > 0 ? allRows.slice(skip) : allRows
}

async function countReadings({ tagIds, startDate, endDate }) {
  if (!tagIds || tagIds.length === 0) return 0
  const start = fluxBound(startDate, '-30d')
  const stop = fluxBound(endDate, 'now()')
  const tagFilter = tagIds.map(id => `r.tagId == "${id}"`).join(' or ')
  const fluxQuery = `from(bucket: "${bucket}")
    |> range(start: ${start}, stop: ${stop})
    |> filter(fn: (r) => r._measurement == "telemetry_reading" and (${tagFilter}))
    |> filter(fn: (r) => r._field == "value")
    |> count()`

  let total = 0
  try {
    for await (const { values, tableMeta } of queryApi.iterateRows(fluxQuery)) {
      total += tableMeta.toObject(values)._value
    }
  } catch (err) {
    console.error('[Influx Query Error] countReadings failed:', err.message, '| Query:', fluxQuery)
  }
  return total
}

async function countByCompany() {
  const fluxQuery = `from(bucket: "${bucket}")
    |> range(start: -30d)
    |> filter(fn: (r) => r._measurement == "telemetry_reading")
    |> filter(fn: (r) => r._field == "value")
    |> group(columns: ["companyId"])
    |> count()`

  const result = {}
  try {
    for await (const { values, tableMeta } of queryApi.iterateRows(fluxQuery)) {
      const row = tableMeta.toObject(values)
      result[row.companyId] = row._value
    }
  } catch (err) {
    console.error('[Influx Query Error] countByCompany failed:', err.message, '| Query:', fluxQuery)
  }
  return result
}

async function networkTraffic(hours = 7) {
  const fluxQuery = `from(bucket: "${bucket}")
    |> range(start: -${hours}h)
    |> filter(fn: (r) => r._measurement == "telemetry_reading")
    |> filter(fn: (r) => r._field == "value")
    |> aggregateWindow(every: 1h, fn: count, createEmpty: false)`

  const now = new Date()
  const labels = []
  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600000)
    labels.push(d.getHours().toString().padStart(2, '0') + ':00')
  }
  const dataMap = {}
  try {
    for await (const { values, tableMeta } of queryApi.iterateRows(fluxQuery)) {
      const row = tableMeta.toObject(values)
      const d = new Date(row._time)
      const key = d.getHours().toString().padStart(2, '0') + ':00'
      dataMap[key] = row._value
    }
  } catch (err) {
    console.error('[Influx Query Error] networkTraffic failed:', err.message, '| Query:', fluxQuery)
  }
  const data = labels.map(h => dataMap[h] || 0)
  return { labels, data }
}

async function getLatestReadings({ tagIds, companyId, limitCount = 1000 }) {
  let tagFilter
  if (tagIds && tagIds.length > 0) {
    tagFilter = tagIds.map(id => `r.tagId == "${id}"`).join(' or ')
  }
  let filterParts = [`r._measurement == "telemetry_reading"`]
  if (tagFilter) filterParts.push(`(${tagFilter})`)
  if (companyId) filterParts.push(`r.companyId == "${companyId}"`)
  const filterExpr = filterParts.join(' and ')
  const fluxQuery = `from(bucket: "${bucket}")
    |> range(start: -30d)
    |> filter(fn: (r) => ${filterExpr})
    |> filter(fn: (r) => r._field == "value")
    |> sort(columns: ["_time"], desc: true)
    |> limit(n: ${limitCount})`

  const result = []
  try {
    for await (const { values, tableMeta } of queryApi.iterateRows(fluxQuery)) {
      const row = tableMeta.toObject(values)
      result.push({
        _id: row._time,
        companyId: row.companyId,
        gatewayId: row.gatewayId,
        tagId: row.tagId,
        value: row._value,
        arrivedAt: row._time
      })
    }
  } catch (err) {
    console.error('[Influx Query Error] getLatestReadings failed:', err.message, '| Query:', fluxQuery)
  }
  return result
}

module.exports = {
  influxDB, queryApi, writeApi, writeReading, flush,
  queryReadings, queryReadingsInTags, countReadings,
  countByCompany, networkTraffic, getLatestReadings, fluxBound,
  org, bucket, url
}

