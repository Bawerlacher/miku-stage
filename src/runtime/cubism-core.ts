import type { RuntimeWindow } from './types'

const CUBISM_CORE_LOCAL_PATH = 'libs/live2dcubismcore.min.js'
const CUBISM_CORE_FALLBACK_SOURCES = [
  'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
  'https://cubism.live2d.com/sdk-res/js/cubismcore/live2dcubismcore.min.js',
]

export async function ensureCubismCore(input: {
  runtimeWindow: RuntimeWindow
  baseUrl: string
}) {
  const { runtimeWindow, baseUrl } = input
  if (runtimeWindow.Live2DCubismCore) {
    return
  }

  if (!runtimeWindow.__mikuCubismPromise) {
    runtimeWindow.__mikuCubismPromise = (async () => {
      const failures: string[] = []
      const sources = [`${baseUrl}${CUBISM_CORE_LOCAL_PATH}`, ...CUBISM_CORE_FALLBACK_SOURCES]

      for (const source of sources) {
        try {
          await loadCubismScript(runtimeWindow, source)
          if (runtimeWindow.Live2DCubismCore) {
            return
          }
          failures.push(`${source} loaded but did not expose Live2DCubismCore`)
        } catch (loadError) {
          const reason = loadError instanceof Error ? loadError.message : 'unknown error'
          failures.push(`${source} failed (${reason})`)
        }
      }

      throw new Error(`Unable to load Cubism runtime. ${failures.join('; ')}`)
    })()
  }

  try {
    await runtimeWindow.__mikuCubismPromise
  } catch (loadError) {
    runtimeWindow.__mikuCubismPromise = undefined
    throw loadError
  }
}

function loadCubismScript(runtimeWindow: RuntimeWindow, source: string) {
  return new Promise<void>((resolve, reject) => {
    const selector = `script[data-miku-cubism-core-src="${source}"]`
    const existing = document.querySelector<HTMLScriptElement>(selector)

    const handleLoad = () => {
      if (runtimeWindow.Live2DCubismCore) {
        resolve()
        return
      }

      reject(new Error('Live2DCubismCore is unavailable after script load'))
    }

    const handleError = () => {
      reject(new Error(`Unable to load script from ${source}`))
    }

    if (existing) {
      if (existing.dataset.loaded === 'true' && runtimeWindow.Live2DCubismCore) {
        resolve()
        return
      }

      existing.addEventListener('load', handleLoad, { once: true })
      existing.addEventListener('error', handleError, { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = source
    script.async = true
    script.crossOrigin = 'anonymous'
    script.dataset.mikuCubismCoreSrc = source
    script.addEventListener(
      'load',
      () => {
        script.dataset.loaded = 'true'
        handleLoad()
      },
      { once: true },
    )
    script.addEventListener('error', handleError, { once: true })
    document.head.appendChild(script)
  })
}
