const { createClient } = require('@supabase/supabase-js')

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || ''
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const CUPR_ID = 144569

async function main() {
  console.log('START FETCH getDatosPuntoRecarga, cuprId =', CUPR_ID)

  let detailJson = null

  try {
    const body = {
      dto: {
        cuprId: [CUPR_ID],
      },
      language: 'en',
    }

    const response = await fetch(
      'https://www.iberdrola.es/o/webclipb/iberdrola/puntosrecargacontroller/getDatosPuntoRecarga',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    )

    console.log('HTTP STATUS:', response.status, response.statusText)

    if (!response.ok) {
      console.error('IBERDROLA RESPONSE NOT OK', {
        status: response.status,
        statusText: response.statusText,
      })
      return
    }

    detailJson = await response.json()
    console.log(
      'POINT DETAILS RESPONSE RAW:',
      JSON.stringify(detailJson, null, 2)
    )
  } catch (err) {
    console.error('HTTP REQUEST FAILED', err)
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
    if (error) {
      console.error('SUPABASE ERROR (charge_logs):', error)
    }
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

    console.log('SUPABASE charge_logs_parsed RESULT:', { data, error })
    if (error) {
      console.error('SUPABASE ERROR (charge_logs_parsed):', error)
    }
  } catch (err) {
    console.error('FAILED TO SAVE INTO charge_logs_parsed', err)
  }

  console.log('DONE')
}

main().catch((err) => {
  console.error('UNHANDLED ERROR IN MAIN', err)
})
