import { Filter } from '@pixi/core'

/**
 * Grain filter — apply to a mid-grey (0x808080) Graphics rect with
 * BLEND_MODES.OVERLAY. Outputs animated noise centered at 0.5 so OVERLAY
 * blend adds grain texture without a net brightness shift.
 */
const GRAIN_FRAGMENT = `
precision mediump float;
varying vec2 vTextureCoord;
uniform float uTime;
uniform float uGrainIntensity;

float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
    float t = floor(uTime * 24.0) / 24.0;
    float noise = rand(vTextureCoord + vec2(t * 0.317, t * 0.123));
    float v = 0.5 + (noise - 0.5) * uGrainIntensity;
    gl_FragColor = vec4(v, v, v, 1.0);
}
`

export class LoFiGrainFilter extends Filter {
  constructor(grainIntensity = 0.30) {
    super(undefined, GRAIN_FRAGMENT, {
      uTime: 0,
      uGrainIntensity: grainIntensity,
    })
  }

  tick(deltaMS: number): void {
    this.uniforms.uTime = (this.uniforms.uTime as number) + deltaMS / 1000
  }
}

/**
 * Vignette filter — apply to a white (0xffffff) Graphics rect with
 * BLEND_MODES.MULTIPLY. Outputs white at center fading to dark at corners;
 * MULTIPLY blend darkens edges of whatever is beneath.
 */
const VIGNETTE_FRAGMENT = `
precision mediump float;
varying vec2 vTextureCoord;
uniform float uVignetteStrength;

void main() {
    vec2 d = vTextureCoord - 0.5;
    float dist = dot(d, d) * 2.8;
    float bright = 1.0 - clamp(dist * uVignetteStrength, 0.0, 0.88);
    gl_FragColor = vec4(bright, bright, bright, 1.0);
}
`

export class LoFiVignetteFilter extends Filter {
  constructor(vignetteStrength = 0.55) {
    super(undefined, VIGNETTE_FRAGMENT, {
      uVignetteStrength: vignetteStrength,
    })
  }
}
