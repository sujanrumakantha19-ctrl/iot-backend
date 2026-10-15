const nodemailer = require('nodemailer')
const AppSetting = require('../models/AppSetting')

/**
 * Helper to retrieve SMTP Transporter configured from DB settings or passed override
 */
async function getTransporter(overrideConfig = null) {
  let config = overrideConfig
  if (!config || !config.host || !config.user) {
    const setting = await AppSetting.findOne({ key: 'smtpConfig' }).lean()
    if (!setting || !setting.value) {
      throw new Error('SMTP server is not configured yet. Please configure SMTP settings under Admin -> Settings.')
    }
    // If overrideConfig only has partial fields (e.g. password empty because already saved)
    config = { ...setting.value, ...(overrideConfig || {}) }
    if (!config.pass && setting.value.pass) {
      config.pass = setting.value.pass
    }
  }

  const { host, port, user, pass, secure, enableAlerts } = config
  if (enableAlerts === false && !overrideConfig) {
    return { disabled: true, config }
  }

  if (!host || !user || !pass) {
    throw new Error('Incomplete SMTP settings. Host, User Email, and Passcode are required.')
  }

  const portNum = parseInt(port, 10) || 587
  // Correctly handle SSL/TLS:
  // Port 465 requires direct SSL (secure: true).
  // Port 587 uses STARTTLS (secure: false).
  // Other ports follow the secure flag.
  const isSecure = portNum === 465 ? true : (portNum === 587 ? false : (secure === true))

  const cleanPass = (pass || '').trim().replace(/\s+/g, '')

  const transporter = nodemailer.createTransport({
    host: (host || 'smtp.gmail.com').trim(),
    port: portNum,
    secure: isSecure,
    auth: {
      user: (user || '').trim(),
      pass: cleanPass
    },
    tls: {
      rejectUnauthorized: false
    }
  })

  return { transporter, config }
}

/**
 * Send a test email to verify SMTP credentials
 */
async function sendTestEmail(targetEmail, overrideConfig = null) {
  const { transporter, config, disabled } = await getTransporter(overrideConfig)
  if (disabled) {
    throw new Error('Email alerts are currently disabled in SMTP settings.')
  }

  const fromEmail = config.fromEmail || config.user

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 20px; }
        .card { max-width: 550px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
        .header { background: linear-gradient(135deg, #1e1b4b 0%, #312e81 100%); padding: 24px; text-align: center; color: #ffffff; }
        .header h1 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.5px; }
        .content { padding: 32px 24px; text-align: center; }
        .badge { display: inline-block; padding: 6px 16px; background-color: #dcfce7; color: #15803d; border-radius: 9999px; font-size: 13px; font-weight: 700; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.5px; }
        .footer { background-color: #f1f5f9; padding: 16px; text-align: center; font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h1>SarayuIIOT Platform</h1>
        </div>
        <div class="content">
          <div class="badge">SMTP Connection Successful</div>
          <h2 style="font-size: 18px; font-weight: 700; color: #0f172a; margin-top: 0;">Test Email Delivered</h2>
          <p style="font-size: 14px; color: #475569; line-height: 1.6;">
            Your SMTP configuration settings on SarayuIIOT have been verified and are working perfectly. System alerts and password reset notifications will be dispatched using these credentials.
          </p>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} SarayuIIOT Platform. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `

  const mailOptions = {
    from: `"SarayuIIOT Platform" <${fromEmail}>`,
    to: targetEmail,
    subject: `[SarayuIIOT] SMTP Connection Test Successful`,
    html: htmlContent
  }

  return await transporter.sendMail(mailOptions)
}

/**
 * Send Password Reset Email
 */
async function sendPasswordResetEmail(targetEmail, userName, tempPasswordOrToken) {
  const { transporter, config, disabled } = await getTransporter()
  if (disabled) return null

  const fromEmail = config.fromEmail || config.user

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 20px; }
        .card { max-width: 550px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
        .header { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 24px; text-align: center; color: #ffffff; }
        .header h1 { margin: 0; font-size: 22px; font-weight: 800; }
        .content { padding: 32px 24px; }
        .code-box { background-color: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; text-align: center; font-family: monospace; font-size: 20px; font-weight: bold; color: #2563eb; letter-spacing: 2px; margin: 20px 0; }
        .footer { background-color: #f1f5f9; padding: 16px; text-align: center; font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h1>SarayuIIOT Platform</h1>
        </div>
        <div class="content">
          <h2 style="font-size: 18px; font-weight: 700; color: #0f172a; margin-top: 0;">Hello ${userName || 'User'},</h2>
          <p style="font-size: 14px; color: #475569; line-height: 1.6;">
            A password reset request was initiated for your account. Please use the temporary password below to log in and update your security settings.
          </p>
          <div class="code-box">${tempPasswordOrToken}</div>
          <p style="font-size: 12px; color: #94a3b8;">
            If you did not request this password reset, please contact your System Administrator immediately.
          </p>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} SarayuIIOT Platform. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `

  return await transporter.sendMail({
    from: `"SarayuIIOT Security" <${fromEmail}>`,
    to: targetEmail,
    subject: `[SarayuIIOT] Password Reset Request`,
    html: htmlContent
  })
}

/**
 * Send Threshold Alert Email to assigned Employee(s) & Manager(s)
 */
async function sendThresholdAlertEmail({ tag, value, severity, recipientEmails, companyName, gatewayName, overrideConfig = null }) {
  if (!recipientEmails || recipientEmails.length === 0) return null

  let res
  try {
    res = await getTransporter(overrideConfig)
  } catch (err) {
    console.error('[EmailService] SMTP error when attempting threshold alert:', err.message)
    throw err
  }

  const { transporter, config, disabled } = res
  if (disabled) return null

  const fromEmail = config.fromEmail || config.user
  const isCritical = severity === 'critical'
  const badgeBg = isCritical ? '#fef2f2' : '#fffbe5'
  const badgeColor = isCritical ? '#dc2626' : '#d97706'
  const badgeBorder = isCritical ? '#fecaca' : '#fde68a'
  const headerGradient = isCritical
    ? 'linear-gradient(135deg, #991b1b 0%, #7f1d1d 100%)'
    : 'linear-gradient(135deg, #b45309 0%, #78350f 100%)'

  const thresholdVal = isCritical ? tag.criticalThreshold : tag.warningThreshold
  const paramLabel = tag.displayName || tag.parameterName || tag.topicName

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 20px; }
        .card { max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
        .header { background: ${headerGradient}; padding: 24px; text-align: center; color: #ffffff; }
        .header h1 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.5px; }
        .header p { margin: 4px 0 0 0; font-size: 12px; opacity: 0.9; text-transform: uppercase; letter-spacing: 1px; }
        .content { padding: 28px 24px; }
        .badge { display: inline-block; padding: 6px 14px; background-color: ${badgeBg}; color: ${badgeColor}; border: 1px solid ${badgeBorder}; border-radius: 9999px; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 20px; }
        .metrics-grid { display: table; width: 100%; margin: 20px 0; border-collapse: separate; border-spacing: 8px; }
        .metric-card { display: table-cell; background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 14px; border-radius: 8px; text-align: center; width: 50%; }
        .metric-label { font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
        .metric-value { font-size: 22px; font-weight: 900; font-family: monospace; color: #0f172a; }
        .details-table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }
        .details-table td { padding: 8px 12px; border-bottom: 1px solid #f1f5f9; }
        .details-table td.label { font-weight: 700; color: #64748b; width: 35%; }
        .details-table td.val { font-weight: 600; color: #1e293b; }
        .footer { background-color: #f1f5f9; padding: 16px; text-align: center; font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h1>SarayuIIOT Telemetry Alert</h1>
          <p>${severity.toUpperCase()} THRESHOLD BREACH</p>
        </div>
        <div class="content">
          <div style="text-align: center;">
            <div class="badge">${severity.toUpperCase()} ALERT</div>
          </div>
          <p style="font-size: 14px; color: #334155; line-height: 1.6; margin-top: 0;">
            Telemetry sensor parameter <strong>"${paramLabel}"</strong> on device node <strong>"${tag.deviceName}"</strong> has crossed its configured ${severity} limit.
          </p>

          <div class="metrics-grid">
            <div class="metric-card">
              <div class="metric-label">Live Value</div>
              <div class="metric-value" style="color: ${badgeColor};">${value} ${tag.unit || ''}</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Set ${severity} Limit</div>
              <div class="metric-value">${thresholdVal} ${tag.unit || ''}</div>
            </div>
          </div>

          <table class="details-table">
            <tr>
              <td class="label">Parameter Name</td>
              <td class="val">${paramLabel} (${tag.parameterName})</td>
            </tr>
            <tr>
              <td class="label">Device Node</td>
              <td class="val">${tag.deviceName}</td>
            </tr>
            <tr>
              <td class="label">Gateway</td>
              <td class="val">${gatewayName || 'N/A'}</td>
            </tr>
            <tr>
              <td class="label">Company Scope</td>
              <td class="val">${companyName || 'N/A'}</td>
            </tr>
            <tr>
              <td class="label">Timestamp</td>
              <td class="val">${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' })}</td>
            </tr>
          </table>
        </div>
        <div class="footer">
          This is an automated alert generated by SarayuIIOT Platform. Please check your system dashboard for live diagnostics.
        </div>
      </div>
    </body>
    </html>
  `

  const uniqueRecipients = [...new Set(recipientEmails.map(e => e.trim()).filter(Boolean))]
  if (uniqueRecipients.length === 0) return null

  const mailOptions = {
    from: `"SarayuIIOT Alerts" <${fromEmail}>`,
    to: uniqueRecipients.join(', '),
    subject: `[${severity.toUpperCase()} ALERT] ${paramLabel} on ${tag.deviceName} - ${value} ${tag.unit || ''}`,
    html: htmlContent
  }

  try {
    const info = await transporter.sendMail(mailOptions)
    console.log(`[EmailService] ${severity.toUpperCase()} Alert email dispatched to ${uniqueRecipients.length} recipient(s):`, info.messageId)
    return info
  } catch (err) {
    console.error(`[EmailService] Failed to send ${severity} alert email:`, err.message)
    return null
  }
}

module.exports = {
  getTransporter,
  sendTestEmail,
  sendPasswordResetEmail,
  sendThresholdAlertEmail
}
