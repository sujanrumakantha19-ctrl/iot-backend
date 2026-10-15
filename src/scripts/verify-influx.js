const { InfluxDB } = require('@influxdata/influxdb-client')

const url = process.env.INFLUXDB_URL || 'http://localhost:8086'
const token = process.env.INFLUXDB_TOKEN || 'iot-token-sarayu-2026'
const org = process.env.INFLUXDB_ORG || 'iotorg'
const bucket = process.env.INFLUXDB_BUCKET || 'iotbucket'

const queryApi = new InfluxDB({ url, token }).getQueryApi(org)

async function verify() {
  const countQuery = `from(bucket: "${bucket}")
    |> range(start: -30d)
    |> filter(fn: (r) => r._measurement == "telemetry_reading" and r._field == "value")
    |> count()
    |> set(key: "result", value: "count")`

  let count = 0
  for await (const { values, tableMeta } of queryApi.iterateRows(countQuery)) {
    count += tableMeta.toObject(values)._value
  }
  console.log(`Total readings in InfluxDB: ${count}`)

}

verify().catch(console.error)
