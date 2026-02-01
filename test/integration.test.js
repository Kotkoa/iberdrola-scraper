const { callRpc } = require('../src/supabaseService')

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || ''

const TEST_CUPR_ID = 144569

async function testCanPollStation() {
  console.log('\n=== Test: can_poll_station ===')

  const { data, error } = await callRpc('can_poll_station', { p_cupr_id: TEST_CUPR_ID })

  if (error) {
    console.error('FAIL:', error.message)
    return false
  }

  const result = data?.[0]
  console.log('Result:', result)

  if (typeof result?.can_poll !== 'boolean') {
    console.error('FAIL: can_poll should be boolean')
    return false
  }

  if (typeof result?.seconds_until_next !== 'number') {
    console.error('FAIL: seconds_until_next should be number')
    return false
  }

  console.log('PASS')
  return true
}

async function testGetStationWithSnapshot() {
  console.log('\n=== Test: get_station_with_snapshot ===')

  const { data, error } = await callRpc('get_station_with_snapshot', { p_cupr_id: TEST_CUPR_ID })

  if (error) {
    console.error('FAIL:', error.message)
    return false
  }

  const result = data?.[0]
  console.log('Result:', {
    cp_id: result?.cp_id,
    name: result?.name,
    port1_status: result?.port1_status,
    port2_status: result?.port2_status,
  })

  if (!result?.cp_id) {
    console.error('FAIL: cp_id should be present')
    return false
  }

  if (!result?.name) {
    console.error('FAIL: name should be present')
    return false
  }

  console.log('PASS')
  return true
}

async function testGetActivePollingTasks() {
  console.log('\n=== Test: get_active_polling_tasks ===')

  const { data, error } = await callRpc('get_active_polling_tasks', {})

  if (error) {
    console.error('FAIL:', error.message)
    return false
  }

  console.log('Result: Active tasks count:', data?.length ?? 0)
  console.log('PASS')
  return true
}

async function testPollStationEdgeFunction() {
  console.log('\n=== Test: poll-station Edge Function ===')

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('SKIP: Missing SUPABASE_URL or SUPABASE_KEY')
    return true
  }

  const url = `${SUPABASE_URL}/functions/v1/poll-station`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ cupr_id: TEST_CUPR_ID }),
    })

    const data = await res.json()
    console.log('Response status:', res.status)
    console.log('Response:', JSON.stringify(data, null, 2))

    if (!res.ok) {
      console.error('FAIL: HTTP', res.status)
      return false
    }

    if (!data.ok) {
      console.error('FAIL:', data.error?.message)
      return false
    }

    if (!data.data?.cp_id) {
      console.error('FAIL: cp_id should be present')
      return false
    }

    console.log('PASS')
    return true
  } catch (err) {
    console.error('FAIL:', err.message)
    return false
  }
}

async function testStartWatchEdgeFunction() {
  console.log('\n=== Test: start-watch Edge Function ===')

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('SKIP: Missing SUPABASE_URL or SUPABASE_KEY')
    return true
  }

  const url = `${SUPABASE_URL}/functions/v1/start-watch`

  const testSubscription = {
    endpoint: 'https://test-endpoint.example.com/push/' + Date.now(),
    keys: {
      p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
      auth: 'tBHItJI5svbpez7KI4CCXg',
    },
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({
        cupr_id: TEST_CUPR_ID,
        port: 1,
        target_status: 'Available',
        subscription: testSubscription,
      }),
    })

    const data = await res.json()
    console.log('Response status:', res.status)
    console.log('Response:', JSON.stringify(data, null, 2))

    if (!res.ok) {
      console.error('FAIL: HTTP', res.status)
      return false
    }

    if (!data.ok) {
      console.error('FAIL:', data.error?.message)
      return false
    }

    if (!data.data?.subscription_id) {
      console.error('FAIL: subscription_id should be present')
      return false
    }

    console.log('PASS')
    return true
  } catch (err) {
    console.error('FAIL:', err.message)
    return false
  }
}

async function testSubscriptionChecker() {
  console.log('\n=== Test: subscriptionChecker.js (dry run) ===')

  const { data, error } = await callRpc('get_active_polling_tasks', {})

  if (error) {
    console.error('FAIL:', error.message)
    return false
  }

  console.log('Active tasks to process:', data?.length ?? 0)

  if (data && data.length > 0) {
    console.log('First task:', {
      task_id: data[0].task_id,
      cupr_id: data[0].cupr_id,
      target_status: data[0].target_status,
      poll_count: data[0].poll_count,
    })
  }

  console.log('PASS')
  return true
}

async function runAllTests() {
  console.log('========================================')
  console.log('  Integration Tests for New Functions')
  console.log('========================================')
  console.log('SUPABASE_URL:', SUPABASE_URL ? 'Set' : 'NOT SET')
  console.log('SUPABASE_KEY:', SUPABASE_KEY ? 'Set' : 'NOT SET')

  const results = []

  results.push({ name: 'can_poll_station', passed: await testCanPollStation() })
  results.push({ name: 'get_station_with_snapshot', passed: await testGetStationWithSnapshot() })
  results.push({ name: 'get_active_polling_tasks', passed: await testGetActivePollingTasks() })
  results.push({ name: 'poll-station Edge Function', passed: await testPollStationEdgeFunction() })
  results.push({ name: 'start-watch Edge Function', passed: await testStartWatchEdgeFunction() })
  results.push({ name: 'subscriptionChecker', passed: await testSubscriptionChecker() })

  console.log('\n========================================')
  console.log('  Test Results')
  console.log('========================================')

  let allPassed = true
  for (const { name, passed } of results) {
    const status = passed ? '✅ PASS' : '❌ FAIL'
    console.log(`${status}: ${name}`)
    if (!passed) allPassed = false
  }

  console.log('========================================')

  if (!allPassed) {
    process.exitCode = 1
  }
}

runAllTests().catch((err) => {
  console.error('Test runner failed:', err)
  process.exitCode = 1
})
