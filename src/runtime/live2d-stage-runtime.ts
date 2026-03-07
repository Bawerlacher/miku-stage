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
  let currentModelUrl = input.initialModelUrl
  let pointerTrackingBound = false

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
    const scale = Math.min(width / model.width, height / model.height) * 0.8

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
    if (!currentModel) {
      return
    }

    layoutModel(currentModel)
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

    currentModel.motion(motion)
  }

  function destroy() {
    window.removeEventListener('resize', handleResize)
    unbindPointerTracking()

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
    hasModel,
    getCurrentModelUrl,
  }
}
