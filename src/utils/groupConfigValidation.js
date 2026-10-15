const createError = require('http-errors')

/**
 * Validates group row parameters against industrial Modbus rules:
 * 1. Max 50 rows per group payload.
 * 2. If groupNum is present (1-20): parameters must follow P{(groupNum-1)*50 + 1} .. P{groupNum*50} range.
 * 3. Slave ID <-> Device Name uniqueness validation across rows and existing devices.
 * 4. Sequential group fill rule validation for full config replacements.
 */
function validateGroupRows(rows, groupNum = null) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw createError(400, 'Config group rows must be a non-empty array')
  }

  if (rows.length > 50) {
    throw createError(400, `Group payload exceeds maximum 50 parameters limit (${rows.length} rows provided).`)
  }

  // Validate group number range
  if (groupNum !== null && groupNum !== undefined) {
    const gNum = Number(groupNum)
    if (isNaN(gNum) || gNum < 1 || gNum > 20) {
      throw createError(400, `Invalid Group Number G${groupNum}. Group numbers must be between 1 and 20.`)
    }
  }

  const seenAddresses = new Map()
  const deviceSlaves = new Map()
  const slaveDevices = new Map()

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!r.deviceName) throw createError(400, `Row ${i + 1}: Device Name is required`)
    if (!r.parameterName) throw createError(400, `Row ${i + 1}: Parameter Name is required`)
    if (isNaN(r.slaveId) || r.slaveId < 0 || r.slaveId > 255) throw createError(400, `Row ${i + 1}: Invalid Slave ID`)

    const devName = String(r.deviceName).replace(/\s+/g, '')
    const sid = Number(r.slaveId)

    if (deviceSlaves.has(devName) && deviceSlaves.get(devName) !== sid) {
      throw createError(400, `Row ${i + 1}: Device Name "${devName}" is already mapped to Slave ID ${deviceSlaves.get(devName)}`)
    }
    deviceSlaves.set(devName, sid)

    if (slaveDevices.has(sid) && slaveDevices.get(sid) !== devName) {
      throw createError(400, `Row ${i + 1}: Slave ID ${sid} is already mapped to Device Name "${slaveDevices.get(sid)}"`)
    }
    slaveDevices.set(sid, devName)

    if (isNaN(r.functionCode) || r.functionCode < 0 || r.functionCode > 255) throw createError(400, `Row ${i + 1}: Invalid Function Code`)
    if (r.address === '' || r.address === null || r.address === undefined || isNaN(Number(r.address)) || Number(r.address) < 0 || Number(r.address) > 65535) {
      throw createError(400, `Row ${i + 1} (${r.parameterName}): Address is required and must be between 0 and 65535`)
    }
    const addressKey = `${Number(r.slaveId)}:${Number(r.address)}`
    if (seenAddresses.has(addressKey)) {
      throw createError(400, `Row ${i + 1} (${r.parameterName}): Duplicate address ${Number(r.address)} for Slave ID ${Number(r.slaveId)}`)
    }
    seenAddresses.set(addressKey, i)

    if (isNaN(r.length) || r.length < 1 || r.length > 65535) throw createError(400, `Row ${i + 1}: Invalid Length`)
    if (typeof r.dataType !== 'string') throw createError(400, `Row ${i + 1}: Invalid Data Type`)
    if (isNaN(r.scaleFactor)) throw createError(400, `Row ${i + 1}: Invalid Scale Factor`)
    if (r.decimal !== undefined && (isNaN(r.decimal) || r.decimal < 0 || r.decimal > 6)) throw createError(400, `Row ${i + 1}: Invalid Decimal value (must be 0-6)`)
    if (isNaN(r.baudRate) || r.baudRate <= 0) throw createError(400, `Row ${i + 1}: Invalid Baud Rate`)
    if (!r.serialConfig) throw createError(400, `Row ${i + 1}: Serial Config is required`)
  }
}

/**
 * Validates full sequential groups structure for full config save / publish.
 * Sequential Gk requires G1..G{k-1} to each have exactly 50 parameters.
 */
function validateSequentialGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return

  const sorted = [...groups].sort((a, b) => Number(a.groupNum) - Number(b.groupNum))
  for (let i = 0; i < sorted.length - 1; i++) {
    const g = sorted[i]
    const rows = g.rows || []
    if (rows.length < 50) {
      throw createError(
        400,
        `Sequential Group Error: Group G${g.groupNum} has only ${rows.length} parameters. Groups prior to the last group must have exactly 50 parameters.`
      )
    }
  }
}

module.exports = {
  validateGroupRows,
  validateSequentialGroups
}
