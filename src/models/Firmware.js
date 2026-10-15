const mongoose = require('mongoose')

const firmwareSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  data: { type: Buffer, required: true },
  contentType: { type: String, default: 'application/octet-stream' },
  createdAt: { type: Date, default: Date.now }
})

module.exports = mongoose.model('Firmware', firmwareSchema)
