const { createClient } = require('@supabase/supabase-js')

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || ''
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const CUPR_ID = 144569
const USER_AGENT =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REFERER =
  process.env.REFERER ||
  'https://www.iberdrola.es/en/electric-mobility/recharge-outside-the-house'
const ORIGIN = process.env.ORIGIN || 'https://www.iberdrola.es'

/**
 * @typedef {Object} ScheduleType
 * @property {string|null} scheduleTypeDesc
 * @property {string|null} scheduleTypeId
 */

/**
 * @typedef {Object} ChargingPointStatus
 * @property {string|null} statusCode
 * @property {string|null} updateDate
 * @property {number} statusId
 */

/**
 * @typedef {Object} SocketType
 * @property {string|null} socketTypeId
 * @property {string|null} socketName
 */

/**
 * @typedef {Object} PhysicalSocket
 * @property {number|null} maxPower
 * @property {SocketType} socketType
 * @property {string|null} status
 * @property {number} physicalSocketId
 */

/**
 * @typedef {Object} LogicalSocket
 * @property {number} logicalSocketId
 * @property {ChargingPointStatus|null} status
 * @property {PhysicalSocket[]} physicalSocket
 * @property {string|null} evseId
 * @property {number} chargeSpeedId
 */

/**
 * @typedef {Object} LocationData
 * @property {string} cuprName
 * @property {ScheduleType|null} scheduleType
 * @property {number} cuprId
 * @property {number} latitude
 * @property {number} longitude
 * @property {string|null} situationCode
 */

/**
 * @typedef {Object} ChargingPoint
 * @property {number} cpId
 * @property {LocationData} locationData
 * @property {LogicalSocket[]} logicalSocket
 * @property {ChargingPointStatus} cpStatus
 * @property {number} socketNum
 * @property {boolean} advantageous
 */

/**
 * @typedef {Object} IberdrolaResponse
 * @property {ChargingPoint[]} entidad
 * @property {boolean} seguro
 * @property {string|null} errorAjax
 * @property {any} errores
 * @property {any} serviceException
 */

/**
 * Fetch charging point data from Iberdrola API
 * @param {number} cuprId - charging point ID
 * @param {number} attempts - number of retry attempts
 * @returns {Promise<IberdrolaResponse|null>}
 */
async function fetchDatos(cuprId, attempts = 3) {
  const body = { dto: { cuprId: [cuprId] }, language: 'en' }

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'en-US,en;q=0.9',
    referer: REFERER,
    origin: ORIGIN,
    'user-agent': USER_AGENT,
    'x-requested-with': 'XMLHttpRequest',
  }

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(
        'https://www.iberdrola.es/o/webclipb/iberdrola/puntosrecargacontroller/getDatosPuntoRecarga',
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }
      )

      console.log('HTTP STATUS:', res.status, res.statusText)

      if (!res.ok) {
        const txt = await res.text().catch(() => '<failed to read body>')
        console.error('IBERDROLA RESPONSE NOT OK', {
          attempt: i + 1,
          status: res.status,
          statusText: res.statusText,
          body_snippet: txt.slice(0, 1000),
        })

        if (res.status === 403 && i < attempts - 1) {
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
          continue
        }
        return null
      }

      const json = await res.json().catch((e) => {
        console.error('FAILED TO PARSE JSON', e)
        return null
      })
      return json
    } catch (err) {
      console.error('HTTP REQUEST FAILED', { attempt: i + 1, err })
      if (i < attempts - 1)
        await new Promise((r) => setTimeout(r, 500 * (i + 1)))
    }
  }

  return null
}

async function main() {
  console.log('START FETCH getDatosPuntoRecarga, cuprId =', CUPR_ID)

  const detailJson = await fetchDatos(CUPR_ID)
  if (!detailJson) {
    console.log('NO DETAIL JSON RECEIVED — skipping DB inserts')
    return
  }

  try {
    console.log('INSERTING INTO SUPABASE: charge_logs...')
    const first = detailJson?.entidad?.[0] ?? {}
    const { data, error } = await supabase.from('charge_logs').insert({
      cp_id: first?.cpId ?? null,
      status: first?.cpStatus?.statusCode ?? null,
      full_json: detailJson,
    })
    console.log('SUPABASE charge_logs RESULT:', { data, error })
    if (error) console.error('SUPABASE ERROR:', error)
  } catch (err) {
    console.error('FAILED TO SAVE INTO charge_logs', err)
  }

  try {
    console.log('INSERTING INTO SUPABASE: charge_logs_parsed...')
    const first = detailJson?.entidad?.[0] ?? {}

    const { data, error } = await supabase.from('charge_logs_parsed').insert({
      cp_id: first?.cpId ?? null,
      cp_name: first?.locationData?.cuprName ?? null,
      schedule: first?.locationData?.scheduleType?.scheduleTypeDesc ?? null,

      port1_status: first?.logicalSocket?.[0]?.status?.statusCode ?? null,
      port1_power_kw:
        first?.logicalSocket?.[0]?.physicalSocket?.[0]?.maxPower ?? null,
      port1_update_date: first?.logicalSocket?.[0]?.status?.updateDate ?? null,

      port2_status: first?.logicalSocket?.[1]?.status?.statusCode ?? null,
      port2_power_kw:
        first?.logicalSocket?.[1]?.physicalSocket?.[0]?.maxPower ?? null,
      port2_update_date: first?.logicalSocket?.[1]?.status?.updateDate ?? null,

      overall_status: first?.cpStatus?.statusCode ?? null,
      overall_update_date: first?.cpStatus?.updateDate ?? null,
    })

    console.log('PARSED INSERT RESULT:', { data, error })
  } catch (err) {
    console.error('FAILED TO SAVE PARSED FIELDS', err)
  }

  console.log('DONE')
}

main().catch((err) => {
  console.error('UNHANDLED ERROR IN MAIN', err)
})
