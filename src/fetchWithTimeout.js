const DEFAULT_TIMEOUT = 15000

/**
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeout]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeout = DEFAULT_TIMEOUT) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

module.exports = { fetchWithTimeout, DEFAULT_TIMEOUT }
