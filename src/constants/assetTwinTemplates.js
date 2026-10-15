const MOTOR_2D_SIEMENS_SLOTS = [
  { key: 'deVib', label: 'DE Vibration', unit: 'mm/s', required: true },
  { key: 'deTemp', label: 'DE Bearing Temp', unit: '°C', required: true },
  { key: 'ndeVib', label: 'NDE Vibration', unit: 'mm/s', required: true },
  { key: 'ndeTemp', label: 'NDE Bearing Temp', unit: '°C', required: true },
  { key: 'rpm', label: 'Motor Speed', unit: 'RPM', required: false },
  { key: 'current', label: 'Supply Current', unit: 'A', required: false }
]

const ASSET_TWIN_TEMPLATES = {
  MOTOR_2D_SIEMENS: {
    id: 'MOTOR_2D_SIEMENS',
    name: 'SIEMENS 3-Phase Induction Motor',
    description: 'Interactive 2D motor digital twin with DE/NDE bearing sensors',
    component: 'MotorDigitalTwin2D',
    slots: MOTOR_2D_SIEMENS_SLOTS
  }
}

const getTemplate = (templateId) => ASSET_TWIN_TEMPLATES[templateId] || null

const getTemplateSlotKeys = (templateId) => {
  const tpl = getTemplate(templateId)
  return tpl ? tpl.slots.map(s => s.key) : []
}

module.exports = {
  ASSET_TWIN_TEMPLATES,
  getTemplate,
  getTemplateSlotKeys
}
