const { fetchDatos } = require('./iberdrolaClient')
const { callRpc, upsertRow, parseEntidad, validateResponse } = require('./supabaseService')

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getActiveTasks() {
  const { data, error } = await callRpc('get_active_polling_tasks', {})
  if (error) {
    console.error('Failed to get active tasks:', error.message)
    return []
  }
  return data || []
}

async function getExpiredTasks() {
  const { data, error } = await callRpc('get_expired_polling_tasks', {})
  if (error) {
    console.error('Failed to get expired tasks:', error.message)
    return []
  }
  return data || []
}

async function canPollStation(cuprId) {
  const { data, error } = await callRpc('can_poll_station', { p_cupr_id: cuprId })
  if (error) {
    console.error('Failed to check poll status:', error.message)
    return { canPoll: false, secondsUntilNext: 300 }
  }
  const result = data?.[0]
  return {
    canPoll: result?.can_poll ?? false,
    secondsUntilNext: result?.seconds_until_next ?? 0,
  }
}

async function updateTaskPollCount(taskId, pollCount) {
  const { error } = await upsertRow(
    'polling_tasks',
    { id: taskId, poll_count: pollCount, status: 'running' },
    'id'
  )
  if (error) {
    console.error(`Failed to update task ${taskId}:`, error.message)
  }
}

async function completeTask(taskId) {
  const { error } = await upsertRow(
    'polling_tasks',
    { id: taskId, status: 'completed' },
    'id'
  )
  if (error) {
    console.error(`Failed to complete task ${taskId}:`, error.message)
  }
}

async function sendPushNotification(subscriptionId, stationName, portStatus) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing Supabase credentials for push notification')
    return
  }

  const url = `${SUPABASE_URL}/functions/v1/send-push-notification`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        subscription_id: subscriptionId,
        title: 'Charging Port Available!',
        body: `${stationName || 'Station'} now has an available port: ${portStatus}`,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error('Push notification failed:', text.slice(0, 200))
    } else {
      console.log(`Push notification sent for subscription ${subscriptionId}`)
    }
  } catch (err) {
    console.error('Push notification error:', err instanceof Error ? err.message : String(err))
  }
}

async function sendExpirationNotification(subscriptionId, targetPort) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing Supabase credentials for push notification')
    return
  }

  const url = `${SUPABASE_URL}/functions/v1/send-push-notification`
  const portText = targetPort ? `Port ${targetPort}` : 'Any port'

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        subscription_id: subscriptionId,
        title: 'Watch Expired',
        body: `${portText} did not become available within 12 hours. Tap to subscribe again.`,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error('Expiration notification failed:', text.slice(0, 200))
    } else {
      console.log(`Expiration notification sent for subscription ${subscriptionId}`)
    }
  } catch (err) {
    console.error('Expiration notification error:', err instanceof Error ? err.message : String(err))
  }
}

function checkTargetReached(parsed, targetPort, targetStatus) {
  if (targetPort === 1) {
    return parsed.port1Status === targetStatus
  }
  if (targetPort === 2) {
    return parsed.port2Status === targetStatus
  }
  return parsed.port1Status === targetStatus || parsed.port2Status === targetStatus
}

function getReachedPortStatus(parsed, targetPort, targetStatus) {
  if (targetPort === 1 && parsed.port1Status === targetStatus) {
    return `Port 1: ${parsed.port1Status}`
  }
  if (targetPort === 2 && parsed.port2Status === targetStatus) {
    return `Port 2: ${parsed.port2Status}`
  }
  if (parsed.port1Status === targetStatus) {
    return `Port 1: ${parsed.port1Status}`
  }
  if (parsed.port2Status === targetStatus) {
    return `Port 2: ${parsed.port2Status}`
  }
  return targetStatus
}

async function saveSnapshot(cpId, parsed) {
  const { error } = await upsertRow(
    'station_snapshots',
    {
      cp_id: cpId,
      source: 'subscription-checker',
      port1_status: parsed.port1Status,
      port1_power_kw: parsed.port1PowerKw,
      port1_price_kwh: parsed.port1PriceKwh ?? 0,
      port1_update_date: parsed.port1UpdateDate,
      port2_status: parsed.port2Status,
      port2_power_kw: parsed.port2PowerKw,
      port2_price_kwh: parsed.port2PriceKwh ?? 0,
      port2_update_date: parsed.port2UpdateDate,
      overall_status: parsed.overallStatus,
      emergency_stop_pressed: parsed.emergencyStopPressed ?? false,
      situation_code: parsed.situationCode,
    },
    'cp_id'
  )

  if (error) {
    console.error(`Failed to save snapshot for cp_id ${cpId}:`, error.message)
    return false
  }
  return true
}

async function cleanupExpiredTasks() {
  const { error } = await callRpc('cleanup_expired_polling_tasks', {})
  if (error && !error.message.includes('does not exist')) {
    console.error('Cleanup error:', error.message)
  }
}

async function processTask(task) {
  const {
    task_id,
    subscription_id,
    cp_id,
    cupr_id,
    target_port,
    target_status,
    poll_count,
    max_polls,
  } = task

  console.log(`Processing task ${task_id} for station cupr_id=${cupr_id}`)

  const { canPoll, secondsUntilNext } = await canPollStation(cupr_id)

  if (!canPoll) {
    console.log(`  Rate limited, next poll in ${secondsUntilNext}s`)
    return
  }

  const response = await fetchDatos(cupr_id, 3)
  if (!response) {
    console.error(`  Failed to fetch data for cupr_id=${cupr_id}`)
    return
  }

  const validation = validateResponse(response)
  if (!validation.valid) {
    console.error(`  Invalid response: ${validation.reason}`)
    return
  }

  const parsed = parseEntidad(response)

  const saved = await saveSnapshot(cp_id, parsed)
  if (!saved) {
    console.error(`  Failed to save snapshot`)
    return
  }

  console.log(`  Status: port1=${parsed.port1Status}, port2=${parsed.port2Status}`)

  const newPollCount = poll_count + 1
  await updateTaskPollCount(task_id, newPollCount)

  const targetReached = checkTargetReached(parsed, target_port, target_status)

  if (targetReached) {
    console.log(`  Target status "${target_status}" reached!`)
    const portStatus = getReachedPortStatus(parsed, target_port, target_status)
    await sendPushNotification(subscription_id, parsed.cpName, portStatus)
    await completeTask(task_id)
    return
  }

  if (newPollCount >= max_polls) {
    console.log(`  Max polls (${max_polls}) reached without target status`)
    await completeTask(task_id)
  }
}

async function processExpiredTask(task) {
  const { task_id, subscription_id, target_port } = task

  console.log(`Processing expired task ${task_id}`)
  await sendExpirationNotification(subscription_id, target_port)
  await completeTask(task_id)
}

async function main() {
  console.log('=== Subscription Checker Started ===')
  console.log(`Time: ${new Date().toISOString()}`)

  // Process expired tasks first (send expiration notifications)
  const expiredTasks = await getExpiredTasks()
  console.log(`Found ${expiredTasks.length} expired polling tasks`)

  for (const task of expiredTasks) {
    await processExpiredTask(task)
    await sleep(500)
  }

  // Process active tasks
  const tasks = await getActiveTasks()
  console.log(`Found ${tasks.length} active polling tasks`)

  if (tasks.length === 0 && expiredTasks.length === 0) {
    console.log('No tasks to process')
    return
  }

  for (const task of tasks) {
    await processTask(task)
    await sleep(1000)
  }

  console.log('=== Subscription Checker Completed ===')
}

main().catch((err) => {
  console.error('Subscription checker failed:', err)
  process.exitCode = 1
})
