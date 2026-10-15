const TelemetryTag = require('../models/TelemetryTag')
const influx = require('../services/influx')

async function updateDashboardStats() {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  const startOfWeek = new Date(startOfToday)
  startOfWeek.setDate(startOfWeek.getDate() - 7)

  const todayQuery = `from(bucket: "${influx.bucket}")
    |> range(start: ${influx.fluxBound(startOfToday)})
    |> filter(fn: (r) => r._measurement == "telemetry_reading")
    |> filter(fn: (r) => r._field == "value")
    |> group(columns: ["tagId"])
    |> max()`

  const yesterdayQuery = `from(bucket: "${influx.bucket}")
    |> range(start: ${influx.fluxBound(startOfYesterday)}, stop: ${influx.fluxBound(startOfToday)})
    |> filter(fn: (r) => r._measurement == "telemetry_reading")
    |> filter(fn: (r) => r._field == "value")
    |> group(columns: ["tagId"])
    |> max()`

  const weekQuery = `from(bucket: "${influx.bucket}")
    |> range(start: ${influx.fluxBound(startOfWeek)})
    |> filter(fn: (r) => r._measurement == "telemetry_reading")
    |> filter(fn: (r) => r._field == "value")
    |> group(columns: ["tagId"])
    |> max()`

  const [todayRows, yesterdayRows, weekRows] = await Promise.all([
    collectRows(influx.queryApi, todayQuery),
    collectRows(influx.queryApi, yesterdayQuery),
    collectRows(influx.queryApi, weekQuery)
  ])

  const todayMap = {}
  todayRows.forEach(r => { todayMap[r.tagId] = r._value })
  const yesterdayMap = {}
  yesterdayRows.forEach(r => { yesterdayMap[r.tagId] = r._value })
  const weekMap = {}
  weekRows.forEach(r => { weekMap[r.tagId] = r._value })

  const bulkOps = []
  const allTagIds = new Set([...Object.keys(todayMap), ...Object.keys(yesterdayMap), ...Object.keys(weekMap)])

  for (const tagId of allTagIds) {
    const update = {}
    if (todayMap[tagId] !== undefined) update.todayMax = todayMap[tagId]
    if (yesterdayMap[tagId] !== undefined) update.yesterdayMax = yesterdayMap[tagId]
    if (weekMap[tagId] !== undefined) update.weekMax = weekMap[tagId]
    if (Object.keys(update).length > 0) {
      update.dashboardUpdatedAt = now
      bulkOps.push({
        updateOne: {
          filter: { _id: tagId },
          update: { $set: update }
        }
      })
    }
  }

  if (bulkOps.length > 0) {
    await TelemetryTag.bulkWrite(bulkOps)
  }

  console.log(`[DashboardStats] Updated ${bulkOps.length} tag stats at ${now.toISOString()}`)
}

async function collectRows(queryApi, fluxQuery) {
  const rows = []
  const iterator = queryApi.iterateRows(fluxQuery)
  for await (const { values, tableMeta } of iterator) {
    rows.push(tableMeta.toObject(values))
  }
  return rows
}

function startDashboardStatsJob(intervalMs = 60000) {
  console.log(`[DashboardStats] Job started, running every ${intervalMs}ms`)
  updateDashboardStats()
  return setInterval(updateDashboardStats, intervalMs)
}

module.exports = { startDashboardStatsJob, updateDashboardStats }
