const vertexSource = `
attribute vec2 position;
varying vec2 uv;
void main() { uv = position * .5 + .5; gl_Position = vec4(position, 0., 1.); }
`;
const fragmentSource = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 uv;
uniform float time, activity, speaking;
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 19.19);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x),
             mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0., a = .5;
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 3.7;
    a *= .5;
  }
  return v;
}
void main() {
  vec2 p = (uv - .5) * 2.;
  float pulse = .987 + activity * .006 * sin(time * 3.);
  // A diffuse white cloud band blends into both the blue sky and lavender base.
  float y = p.y / pulse * .5 + .5;
  vec2 flow = vec2(p.x * 2.1 + time * .28, y * 3. - time * .12);
  flow += vec2(sin(y * 4. + time * .3), sin(p.x * 2.4 - time * .2))
          * (.18 + speaking * .35 + activity * .25);
  float broad = fbm(flow);
  float detail = fbm(flow * 2.3 + vec2(broad * 1.5, time * .10));
  // Speech pulls blue, white and lavender into broad overlapping currents.
  // Reuse the same noise samples so mixing does not add another noise pass.
  float currents = .13 * sin(p.x * 3.2 + time * .95)
                   + .08 * sin(p.x * 1.7 - time * .70)
                   + (broad - .45) * .60 + (detail - .45) * .18;
  y += (speaking + activity * .55) * currents + (broad - .45) * .06;
  float wave = sin(p.x * 2.5 + time * .85);
  float center = .535 + (.025 + activity * .025) * wave
                 + (broad - .45) * .18 + (detail - .45) * .05;
  float upperEdge = center + .14 + speaking * .08 + (detail - .45) * .18;
  float lowerEdge = center - .23 - speaking * .07 + (broad - .45) * .10;
  float mist = smoothstep(lowerEdge, center - .005, y)
               * (1. - smoothstep(center + .015, upperEdge, y));
  vec3 lavender = vec3(.70, .76, .98);
  vec3 blue = vec3(.20, .38, .91);
  vec3 color = mix(lavender, blue, smoothstep(.37, .88, y));
  color = mix(color, vec3(.97, .985, 1.), mist * .95);
  // Render only the opaque color field here. CSS clips its circle at display resolution.
  gl_FragColor = vec4(color, 1.);
}
`;

export class OrbRenderer {
  time = 0;
  activity = 0;
  speaking = 0;
  envelope = 0;
  renderSize = 1;
  last = 0;
  frame = 0;
  inView = true;
  motion = matchMedia('(prefers-reduced-motion: reduce)');

  constructor(host, canvas) {
    this.host = host;
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!this.gl) return;
    this.onLost = event => { event.preventDefault(); this.stop(); this.markReady(false); };
    this.onRestored = () => { this.initialize(); this.refresh(); };
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.motion.addEventListener('change', this.refresh);
    document.addEventListener('visibilitychange', this.refresh);
    this.resize = new ResizeObserver(this.refresh);
    this.resize.observe(host);
    this.intersection = new IntersectionObserver(([entry]) => { this.inView = entry.isIntersecting; this.refresh(); });
    this.intersection.observe(host);
    this.initialize();
    this.refresh();
  }

  markReady(value) { this.canvas.parentElement.classList.toggle('rendered', value); }
  initialize() {
    const gl = this.gl;
    this.release();
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); return null; }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertex || !fragment) {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
      return;
    }
    const program = gl.createProgram();
    if (!program) { gl.deleteShader(vertex); gl.deleteShader(fragment); return; }
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return; }
    this.program = program;
    gl.useProgram(program);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.uniforms = Object.fromEntries(['time', 'activity', 'speaking'].map(name => [name, gl.getUniformLocation(program, name)]));
    this.markReady(true);
  }

  stop() { cancelAnimationFrame(this.frame); this.frame = 0; this.last = 0; }
  refresh = () => {
    this.stop();
    if (!this.program || this.gl.isContextLost()) return;
    // One-fifth CSS resolution, independent of display DPR; cap large instances.
    // Resize only on layout/attribute changes rather than reading layout every frame.
    const requestedScale = Number(this.host.getAttribute('render-scale') ?? .2);
    const scale = Number.isFinite(requestedScale) ? Math.min(1, Math.max(.1, requestedScale)) : .2;
    this.renderSize = Math.min(256, Math.max(1, Math.round(this.host.clientWidth * scale)));
    this.draw(0);
    if (!this.host.hasAttribute('paused') && !this.motion.matches && !document.hidden && this.inView) {
      this.frame = requestAnimationFrame(this.tick);
    }
  };
  tick = now => {
    const delta = this.last ? Math.min((now - this.last) / 1000, .05) : 0;
    this.last = now;
    this.draw(delta);
    this.frame = requestAnimationFrame(this.tick);
  };
  draw(delta) {
    const reactive = this.host.hasAttribute('audio-reactive');
    const rawLevel = reactive && ['listening', 'speaking'].includes(this.host.state) ? this.host.level : 0;
    // Lift quiet syllables without exceeding the desktop's fixed 54 px hit area.
    const level = Number.isFinite(rawLevel) ? Math.min(1, Math.pow(Math.max(0, rawLevel), .65) * 1.25) : 0;
    this.envelope += (level - this.envelope) * (1 - Math.exp(-delta * (level > this.envelope ? 48 : 12)));
    if (reactive) this.host.style.setProperty('--audio-scale', String(1 + this.envelope * .2));
    const target = this.host.state === 'speaking' ? .65 + .25 * Math.sin(this.time * 7.3)
      : this.host.state === 'listening' ? .28 : .06;
    this.activity += ((reactive ? .06 + this.envelope * .94 : target) - this.activity) * (1 - Math.exp(-delta * 18));
    this.speaking += ((this.host.state === 'speaking' ? 1 : 0) - this.speaking)
      * (1 - Math.exp(-delta * 3));
    // Speech accelerates the cloud flow fourfold, easing with the speaking blend.
    this.time += delta * (.9 + this.activity * 2.5) * (1 + this.speaking * 3);
    const gl = this.gl;
    const size = this.renderSize;
    if (this.canvas.width !== size || this.canvas.height !== size) {
      this.canvas.width = size; this.canvas.height = size;
    }
    gl.viewport(0, 0, size, size);
    gl.uniform1f(this.uniforms.time, this.time);
    gl.uniform1f(this.uniforms.activity, this.activity);
    gl.uniform1f(this.uniforms.speaking, this.speaking);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  release() {
    if (this.buffer) this.gl.deleteBuffer(this.buffer);
    if (this.program) this.gl.deleteProgram(this.program);
    this.buffer = this.program = undefined;
    this.markReady(false);
  }
  dispose() {
    this.stop();
    this.resize?.disconnect(); this.intersection?.disconnect();
    this.motion.removeEventListener('change', this.refresh);
    document.removeEventListener('visibilitychange', this.refresh);
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (this.gl) this.release();
  }
}
