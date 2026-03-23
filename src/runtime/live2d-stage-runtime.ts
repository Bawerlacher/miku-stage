/**
 * Live2D canvas runtime responsible for model load, render, and stage interactions.
 */
import type { Ref } from 'vue'
import * as PIXI from 'pixi.js'
import type { RuntimeWindow } from './types'

type Live2DModule = typeof import('pixi-live2d-display/cubism4')
type Live2DModelInstance = Awaited<ReturnType<Live2DModule['Live2DModel']['from']>>

export type Live2DStageRuntime = {
  init: () => void
  destroy: () => void
  loadModel: (nextModelUrl?: string) => Promise<void>
  applyModelFocus: (payload: unknown) => void
  applyModelMotion: (payload: unknown) => void
  startThinkingMotion: () => void
  stopThinkingMotion: () => void
  hasModel: () => boolean
  getCurrentModelUrl: () => string
}

export function createLive2DStageRuntime(input: {
  runtimeWindow: RuntimeWindow
  stageHost: Ref<HTMLDivElement | null>
  canvas: Ref<HTMLCanvasElement | null>
  initialModelUrl: string
}): Live2DStageRuntime {
  const { runtimeWindow, stageHost, canvas } = input
  runtimeWindow.PIXI = PIXI

  let live2dModule: Live2DModule | null = null
  let app: PIXI.Application | null = null
  let currentModel: Live2DModelInstance | null = null
  let lofiOverlay: PIXI.Container | null = null
  let lofiWarmthG: PIXI.Graphics | null = null
  let lofiVignetteSprite: PIXI.Sprite | null = null
  let currentModelUrl = input.initialModelUrl
  let pointerTrackingBound = false
  let isThinking = false
  let currentMotionManager: any = null

  const THINKING_MOTION_GROUP = 'Thinking'

  function handleMotionFinish() {
    console.debug('[live2d] motionFinish fired, isThinking:', isThinking)
    if (!isThinking || !currentModel) {
      return
    }
    // Defer past state.complete() — motionFinish fires before the manager clears
    // currentPriority, so a synchronous reserve() call here gets rejected.
    // queueMicrotask runs after the full update() tick, at which point
    // currentPriority is 0 and the Thinking reservation wins over Idle.
    const modelSnapshot = currentModel
    queueMicrotask(() => {
      if (!isThinking || currentModel !== modelSnapshot) {
        console.debug('[live2d] thinking restart skipped (stopped or model changed)')
        return
      }
      console.debug('[live2d] restarting Thinking motion')
      void modelSnapshot.motion(THINKING_MOTION_GROUP)
    })
  }

  async function getLive2DModule() {
    if (!live2dModule) {
      live2dModule = await import('pixi-live2d-display/cubism4')
    }

    return live2dModule
  }

  function getHostSize() {
    return {
      width: stageHost.value?.clientWidth || window.innerWidth,
      height: stageHost.value?.clientHeight || window.innerHeight,
    }
  }

  function layoutModel(model: Live2DModelInstance) {
    const { width, height } = getHostSize()
    const scale = Math.min(width / model.width, height / model.height) * 0.9

    model.scale.set(scale)
    model.anchor.set(0.5, 0.5)
    model.position.set(width / 2, height / 2)
  }

  function normalizeModelId(rawId: unknown) {
    if (typeof rawId === 'string') {
      return rawId
    }

    if (rawId && typeof rawId === 'object') {
      const idObject = rawId as { s?: unknown }
      if (typeof idObject.s === 'string') {
        return idObject.s
      }
    }

    return null
  }

  function remapFocusParameterIds(model: Live2DModelInstance) {
    const internalModel = (model as any)?.internalModel
    const coreModel = internalModel?.coreModel
    const coreParameterIds: unknown[] = Array.isArray(coreModel?._parameterIds)
      ? coreModel._parameterIds
      : []
    const parameterIds = coreParameterIds
      .map((id) => normalizeModelId(id))
      .filter((id): id is string => Boolean(id))

    if (!parameterIds.length || !internalModel) {
      return
    }

    const availableIds = new Set(parameterIds)
    const mappings: Array<[string, string[]]> = [
      ['idParamEyeBallX', ['PARAM_EYE_BALL_X', 'ParamEyeBallX']],
      ['idParamEyeBallY', ['PARAM_EYE_BALL_Y', 'ParamEyeBallY']],
      ['idParamAngleX', ['PARAM_ANGLE_X', 'ParamAngleX']],
      ['idParamAngleY', ['PARAM_ANGLE_Y', 'ParamAngleY']],
      ['idParamAngleZ', ['PARAM_ANGLE_Z', 'ParamAngleZ']],
      ['idParamBodyAngleX', ['PARAM_BODY_ANGLE_X', 'ParamBodyAngleX']],
    ]

    for (const [field, candidates] of mappings) {
      const matchedId = candidates.find((candidate) => availableIds.has(candidate))
      if (matchedId) {
        internalModel[field] = matchedId
      }
    }
  }

  function handlePointerMove(event: PointerEvent) {
    if (!currentModel) {
      return
    }

    currentModel.focus(event.clientX, event.clientY)
  }

  function handlePointerLeave() {
    if (!currentModel) {
      return
    }

    const { width, height } = getHostSize()
    currentModel.focus(width / 2, height / 2)
  }

  function bindPointerTracking() {
    if (pointerTrackingBound || !stageHost.value) {
      return
    }

    stageHost.value.addEventListener('pointermove', handlePointerMove)
    stageHost.value.addEventListener('pointerleave', handlePointerLeave)
    pointerTrackingBound = true
  }

  function unbindPointerTracking() {
    if (!pointerTrackingBound || !stageHost.value) {
      return
    }

    stageHost.value.removeEventListener('pointermove', handlePointerMove)
    stageHost.value.removeEventListener('pointerleave', handlePointerLeave)
    pointerTrackingBound = false
  }

  function handleResize() {
    const { width, height } = getHostSize()
    if (currentModel) layoutModel(currentModel)
    if (lofiOverlay) drawLoFiRects(width, height)
  }

  // Bake a vignette into an HTML canvas (no PIXI filter pipeline involved).
  // Returns a PixiJS texture from the canvas element.
  function createVignetteTexture(width: number, height: number): PIXI.Texture {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')!
    const cx = width / 2
    const cy = height / 2
    const r = Math.max(width, height) * 0.75
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    grd.addColorStop(0.35, 'rgba(0,0,0,0)')
    grd.addColorStop(1.0, 'rgba(0,0,0,0.82)')
    ctx.fillStyle = grd
    ctx.fillRect(0, 0, width, height)
    return PIXI.Texture.from(c)
  }

  function drawLoFiRects(width: number, height: number) {
    // Warmth: redraw to new dimensions
    lofiWarmthG?.clear()
    lofiWarmthG?.beginFill(0xff9933) // amber
    lofiWarmthG?.drawRect(0, 0, width, height)
    lofiWarmthG?.endFill()

    // Vignette: recreate canvas texture at new dimensions
    if (lofiVignetteSprite) {
      const old = lofiVignetteSprite.texture
      lofiVignetteSprite.texture = createVignetteTexture(width, height)
      old.destroy(true)
    }
  }

  function buildLoFiOverlay(width: number, height: number): PIXI.Container {
    const container = new PIXI.Container()

    // Layer 1: warm amber tint at low opacity — no blend mode tricks, just alpha
    lofiWarmthG = new PIXI.Graphics()
    lofiWarmthG.alpha = 0.07
    container.addChild(lofiWarmthG)

    // Layer 2: vignette from HTML canvas radial gradient — no PIXI filter pipeline
    lofiVignetteSprite = new PIXI.Sprite()
    container.addChild(lofiVignetteSprite)

    drawLoFiRects(width, height)
    return container
  }

  function payloadAsObject(payload: unknown) {
    if (!payload || typeof payload !== 'object') {
      return {}
    }

    return payload as Record<string, unknown>
  }

  async function loadModel(nextModelUrl = currentModelUrl) {
    if (!app) {
      return
    }

    const { Live2DModel } = await getLive2DModule()
    const nextModel = await Live2DModel.from(nextModelUrl)

    if (currentModel) {
      app.stage.removeChild(currentModel)
      currentModel.destroy()
    }

    currentModel = nextModel
    currentModelUrl = nextModelUrl

    if (currentMotionManager) {
      currentMotionManager.off('motionFinish', handleMotionFinish)
    }
    currentMotionManager = (nextModel as any).internalModel?.motionManager ?? null
    if (currentMotionManager) {
      currentMotionManager.on('motionFinish', handleMotionFinish)
    }

    app.stage.addChild(nextModel)
    layoutModel(nextModel)
    remapFocusParameterIds(nextModel)
    ;(window as Window & { miku?: Live2DModelInstance }).miku = nextModel
  }

  function init() {
    if (!canvas.value || !stageHost.value) {
      return
    }

    if (!app) {
      app = new PIXI.Application({
        view: canvas.value,
        autoStart: true,
        resizeTo: stageHost.value,
        backgroundAlpha: 1,
        backgroundColor: 0xffffff,
      })
    }

    // LoFi overlay: rendered as plain display objects on top of the model.
    // Filtering app.stage directly (or any container holding the Live2D model)
    // breaks pixi-live2d-display's custom WebGL renderer. Effects are composited
    // as separate overlay objects with no PIXI filter pipeline involvement.
    app.stage.sortableChildren = true
    const { width, height } = getHostSize()
    lofiOverlay = buildLoFiOverlay(width, height)
    lofiOverlay.zIndex = 10 // above model (default zIndex = 0)
    app.stage.addChild(lofiOverlay)

    bindPointerTracking()
    window.addEventListener('resize', handleResize)
  }

  function applyModelFocus(payload: unknown) {
    if (!currentModel) {
      return
    }

    const focus = payloadAsObject(payload)
    const nextScale = typeof focus.scale === 'number' ? focus.scale : null
    const nextX = typeof focus.x === 'number' ? focus.x : null
    const nextY = typeof focus.y === 'number' ? focus.y : null

    if (nextScale !== null) {
      currentModel.scale.set(nextScale)
    }

    if (nextX !== null && nextY !== null) {
      currentModel.position.set(nextX, nextY)
    }
  }

  function applyModelMotion(payload: unknown) {
    if (!currentModel) {
      return
    }

    const motionPayload = payloadAsObject(payload)
    const motion =
      typeof motionPayload.motion === 'string' ? motionPayload.motion.trim() : ''

    if (!motion) {
      return
    }

    // Stop thinking first so its NORMAL priority slot is freed before we
    // try to reserve the new motion (also NORMAL). Without this the new
    // motion's reserve() call is rejected: priority(2) <= currentPriority(2).
    stopThinkingMotion()
    currentModel.motion(motion)
  }

  function startThinkingMotion() {
    if (!currentModel) {
      console.debug('[live2d] startThinkingMotion: no model loaded, skipping')
      return
    }
    console.debug('[live2d] startThinkingMotion')
    isThinking = true
    void currentModel.motion(THINKING_MOTION_GROUP)
  }

  function stopThinkingMotion() {
    if (!isThinking) {
      return
    }
    console.debug('[live2d] stopThinkingMotion')
    isThinking = false
    // Immediately clear the motion queue so the next motion can reserve at
    // NORMAL priority. Without this, the thinking motion keeps holding
    // currentPriority=2 until it naturally finishes, blocking anything else.
    currentMotionManager?.stopAllMotions()
  }

  function destroy() {
    window.removeEventListener('resize', handleResize)
    unbindPointerTracking()
    if (currentMotionManager) {
      currentMotionManager.off('motionFinish', handleMotionFinish)
      currentMotionManager = null
    }

    lofiOverlay = null
    lofiWarmthG = null
    lofiVignetteSprite = null

    if (app) {
      app.destroy(true)
      app = null
    }

    currentModel = null
  }

  function hasModel() {
    return Boolean(currentModel)
  }

  function getCurrentModelUrl() {
    return currentModelUrl
  }

  return {
    init,
    destroy,
    loadModel,
    applyModelFocus,
    applyModelMotion,
    startThinkingMotion,
    stopThinkingMotion,
    hasModel,
    getCurrentModelUrl,
  }
}
