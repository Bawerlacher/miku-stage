/**
 * Shared runtime environment types used by stage runtime modules.
 */
import type * as PIXI from 'pixi.js'

export type StageConfig = {
  bridgeUrl?: string
  modelUrl?: string
}

export type RuntimeWindow = Window &
  typeof globalThis & {
    Live2DCubismCore?: unknown
    PIXI?: typeof PIXI
    __mikuCubismPromise?: Promise<void>
    __mikuStageConfig__?: StageConfig
  }
