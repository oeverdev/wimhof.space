// The original pictures remain the texture: no new fork is drawn by the app.
// A small readable motion follows decoded audio time and its measured level.
// This is a visual interpretation, not a display of physical sound frequency.
const VERTEX = `attribute vec2 p; varying vec2 uv; void main(){uv=vec2((p.x+1.0)*.5,(1.0-p.y)*.5);gl_Position=vec4(p,0.,1.);}`;
const FRAGMENT = `precision highp float;
varying vec2 uv; uniform sampler2D source; uniform vec2 cover; uniform vec3 background;
uniform float wave; uniform float width; uniform float original;
void main(){
  vec2 q=(uv-.5)*cover+.5;
  if(q.x<0. || q.x>1. || q.y<0. || q.y>1.){
    gl_FragColor=vec4(background,1.);
    return;
  }
  if(original>.5){
    float y=q.y;
    float vertical=smoothstep(.006,.032,y)*(1.-smoothstep(.70,.77,y));
    float bend=pow(clamp((.77-y)/.74,0.,1.),2.2);
    float leftCenter=.463-.019*y;
    float rightCenter=.544-.031*y;
    float leftMask=1.-smoothstep(.022,.039,abs(q.x-leftCenter));
    float rightMask=1.-smoothstep(.022,.039,abs(q.x-rightCenter));
    q.x-=wave/max(width,1.)*vertical*bend*(rightMask-leftMask);
  }else{
    // Other compositions receive a subtle source-preserving sway, avoiding
    // assumed tine locations or anatomy copied from an unrelated photograph.
    q.x-=wave*.20/max(width,1.);
  }
  gl_FragColor=texture2D(source,q);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error('Animation shader unavailable');
  return shader;
}
class PictureMotion {
  constructor(canvas, image, original) {
    this.canvas = canvas;
    this.aspect = image.naturalWidth / image.naturalHeight;
    this.original = original;
    this.gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: true });
    if (!this.gl) throw Error('WebGL unavailable');
    const gl = this.gl;
    this.program = gl.createProgram();
    this.shaders = [compile(gl, gl.VERTEX_SHADER, VERTEX), compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)];
    this.shaders.forEach(shader => gl.attachShader(this.program, shader));
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw Error('Animation shader unavailable');
    gl.useProgram(this.program);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    const attribute = gl.getAttribLocation(this.program, 'p');
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
    this.locations = Object.fromEntries(['source', 'cover', 'wave', 'width', 'original', 'background'].map(name => [name, gl.getUniformLocation(this.program, name)]));
    this.texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.uniform1i(this.locations.source, 0);
    gl.uniform1f(this.locations.original, original ? 1 : 0);
    // Match the letterbox to the image's own side colors. The source is kept
    // intact and fully visible; this only supplies the surrounding canvas.
    let background = [33, 45, 51];
    try {
      const sampler = document.createElement('canvas');
      sampler.width = 2; sampler.height = 1;
      const sample = sampler.getContext('2d');
      sample.drawImage(image, 0, Math.floor(image.naturalHeight / 2), 1, 1, 0, 0, 1, 1);
      sample.drawImage(image, image.naturalWidth - 1, Math.floor(image.naturalHeight / 2), 1, 1, 1, 0, 1, 1);
      const pixels = sample.getImageData(0, 0, 2, 1).data;
      background = [0, 1, 2].map(channel => Math.round((pixels[channel] + pixels[channel + 4]) / 2));
    } catch { /* The neutral background also works if pixels are unavailable. */ }
    canvas.parentElement.style.setProperty('--image-bg', `rgb(${background.join(',')})`);
    gl.uniform3fv(this.locations.background, background.map(channel => channel / 255));
    this.lost = false;
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.lost = true;
      canvas.dataset.motion = 'unavailable';
    });
    this.resize();
    this.draw(0);
    canvas.dataset.motion = 'ready';
  }
  resize() {
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.cssWidth = width;
    const displayAspect = width / height;
    this.cover = this.original
      ? displayAspect > this.aspect ? [1, this.aspect / displayAspect] : [displayAspect / this.aspect, 1]
      : displayAspect > this.aspect ? [displayAspect / this.aspect, 1] : [1, this.aspect / displayAspect];
  }
  draw(wave) {
    if (this.lost) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform2fv(this.locations.cover, this.cover);
    gl.uniform1f(this.locations.width, this.cssWidth);
    gl.uniform1f(this.locations.wave, wave);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.canvas.dataset.deflection = wave.toFixed(4);
  }
  destroy() {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
    this.shaders.forEach(shader => this.gl.deleteShader(shader));
  }
}

export class SceneMotion {
  constructor({ cards, tracks, media }) {
    this.media = media;
    this.tracks = tracks;
    this.scenes = new Map();
    this.enabled = true;
    this.frame = 0;
    this.lastFrame = 0;
    this.lastTrack = null;
    this.lastPosition = -1;
    this.lastWave = 0;
    this.lastLevel = 0;
    this.disposed = false;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    this.onChange = () => { this.render(); this.schedule(); };
    this.onVisibility = () => { if (document.hidden) this.cancel(); else this.onChange(); };
    this.onReduced = () => this.setEnabled(this.enabled);
    media.addEventListener('change', this.onChange);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.reduced.addEventListener('change', this.onReduced);
    this.observer = new ResizeObserver(() => {
      // Resizing clears a WebGL drawing buffer. Repaint every visible source,
      // including inactive cards, before restoring the selected moving pose.
      for (const scene of this.scenes.values()) { scene.resize(); scene.draw(0); }
      this.render();
    });
    for (const card of cards) this.initialize(card);
  }
  initialize(card) {
    const image = card.querySelector('.sound-image');
    const canvas = card.querySelector('canvas');
    const id = card.dataset.track;
    const create = () => {
      if (this.disposed || this.scenes.has(id) || !image.naturalWidth) return;
      try {
        const scene = new PictureMotion(canvas, image, /fork-original\.jpg/.test(image.src));
        this.scenes.set(id, scene);
        this.observer.observe(canvas);
        this.onChange();
      } catch { canvas.dataset.motion = 'unavailable'; }
    };
    if (image.complete) create(); else image.addEventListener('load', create, { once: true });
  }
  cancel() { cancelAnimationFrame(this.frame); this.frame = 0; }
  setEnabled(enabled) { this.enabled = Boolean(enabled); this.cancel(); this.render(); this.schedule(); }
  schedule() {
    if (!this.frame && !this.disposed && !document.hidden && this.enabled && !this.reduced.matches && this.media.getSnapshot().audio.state === 'playing') this.frame = requestAnimationFrame(time => this.tick(time));
  }
  tick(time) {
    this.frame = 0;
    if (time - this.lastFrame >= 33) { this.lastFrame = time; this.render(); }
    this.schedule();
  }
  render() {
    if (this.disposed) return;
    const audio = this.media.getSnapshot().audio;
    const selected = audio.trackId;
    const position = Number(audio.position) || 0;
    const enabled = this.enabled && !this.reduced.matches;
    const playing = audio.state === 'playing';
    if (selected !== this.lastTrack) {
      const previous = this.scenes.get(this.lastTrack);
      previous?.draw(0);
      if (previous) previous.canvas.dataset.playing = 'false';
      this.lastTrack = selected;
      this.lastPosition = -1;
      this.lastWave = 0;
      this.lastLevel = 0;
    }
    if (playing) this.lastLevel = Math.max(0, Math.min(1, this.media.getAudioLevel()));
    if (playing || Math.abs(position - this.lastPosition) > .0001) {
      const duration = Number(audio.duration) || 1;
      const visualCycles = Math.max(1, Math.round(duration * 6));
      this.lastWave = Math.sin(position / duration * visualCycles * Math.PI * 2) * Math.min(1.6, this.lastLevel * 8);
      this.lastPosition = position;
    }
    const scene = this.scenes.get(selected);
    scene?.draw(enabled ? this.lastWave : 0);
    if (scene) scene.canvas.dataset.playing = String(playing);
    if (!playing) this.cancel();
  }
  destroy() {
    this.disposed = true;
    this.cancel();
    this.observer.disconnect();
    this.media.removeEventListener('change', this.onChange);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.reduced.removeEventListener('change', this.onReduced);
    this.scenes.forEach(scene => scene.destroy());
  }
}
