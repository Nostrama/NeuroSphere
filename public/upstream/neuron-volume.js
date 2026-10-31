/* View-only 3D renderer. No simulation state or random draws are changed here. */
(function (root) {
  "use strict";
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const scale = (a, s) => a.map(v => v * s);
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = a => Math.hypot(...a);
  const unit = a => scale(a, 1 / Math.max(1e-9, length(a)));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sphereRadius = cell => cell.recordOutput || cell.drivePeriod !== null ? 15 : 11;
  const world = (point, extent) => [point.x - extent.x / 2, extent.y / 2 - point.y, point.z - extent.z / 2];

  // Illustration only: stable local coordinates, independent of the model's RNG,
  // sensing radius, connections and camera. The longer arbor is an axon silhouette.
  function neuronShape(id) {
    const stems = [];
    const curved = (start, direction, reach, bend, radius, kind, steps = 4) => {
      const points = Array.from({ length: steps + 1 }, (_, i) => {
        const t = i / steps;
        return add(start, add(scale(direction, reach * t), scale(bend, Math.sin(t * Math.PI / 2))));
      });
      stems.push({ points, radius, kind });
      return points;
    };
    for (let branch = 0; branch < 6; branch++) {
      const height = -0.78 + branch * 0.31, angle = branch * 2.4 + id * 0.73;
      const direction = [Math.cos(angle) * Math.sqrt(1 - height * height), height, Math.sin(angle) * Math.sqrt(1 - height * height)];
      const side = unit(cross(direction, [0, 1, 0]));
      const axon = branch === 0, kind = axon ? "axon" : "dendrite";
      const reach = axon ? 66 : 30 + (id * (branch + 2)) % 12;
      const points = curved(scale(direction, 6), direction, reach, scale(side, (branch % 2 ? -1 : 1) * 8), axon ? 2.1 : 3.1, kind);
      for (const sign of [-1, 1]) {
        const start = points[axon ? 3 : 2];
        const forkDirection = unit(add(direction, scale(side, sign * (axon ? 0.55 : 0.85))));
        const fork = curved(start, forkDirection, axon ? 22 : 18, scale(side, sign * 5), 1.15, kind, 3);
        if (!axon) curved(fork[2], unit(add(forkDirection, scale(direction, -0.6))), 9, scale(side, sign * 2), 0.55, kind, 2);
      }
    }
    return { stems, radii: [1 + 0.1 * Math.sin(id), 0.86, 1 + 0.08 * Math.cos(id)] };
  }

  class OrbitCamera {
    constructor() { this.width = 1; this.height = 1; this.extent = { x: 1000, y: 620, z: 620 }; this.reset(); }
    reset(view = "perspective") {
      this.yaw = view === "front" ? 0 : view === "top" ? 0 : -0.5;
      this.pitch = view === "top" ? Math.PI / 2 - 0.001 : view === "front" ? 0 : 0.3;
      this.zoom = 1; this.target = [0, 0, 0];
    }
    resize(width, height, extent = this.extent) { this.width = Math.max(1, width); this.height = Math.max(1, height); this.extent = extent; }
    basis() {
      const aspect = this.width / this.height, fov = Math.PI / 4;
      const radius = Math.hypot(this.extent.x, this.extent.y, this.extent.z) / 2;
      const halfAngle = Math.atan(Math.tan(fov / 2) * Math.min(1, aspect));
      const distance = radius / Math.sin(halfAngle) * 1.08 / this.zoom;
      const offset = [Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch)];
      const eye = add(this.target, scale(offset, distance)), forward = scale(offset, -1);
      const right = unit(cross(forward, [0, 1, 0])), up = cross(right, forward);
      return { eye, forward, right, up, distance, aspect, lens: 1 / Math.tan(fov / 2), near: 1, far: radius * 30 };
    }
    project(position) {
      const b = this.basis(), delta = sub(position, b.eye), depth = dot(delta, b.forward);
      return { x: this.width / 2 + dot(delta, b.right) * b.lens / b.aspect / depth * this.width / 2,
        y: this.height / 2 - dot(delta, b.up) * b.lens / depth * this.height / 2,
        depth, scale: this.height * b.lens / (2 * depth), visible: depth > b.near && depth < b.far };
    }
    ray(x, y) {
      const b = this.basis();
      return { origin: b.eye, direction: unit(add(b.forward, add(
        scale(b.right, (2 * x / this.width - 1) * b.aspect / b.lens),
        scale(b.up, (1 - 2 * y / this.height) / b.lens)))) };
    }
    orbit(dx, dy) { this.yaw -= dx * 0.007; this.pitch = clamp(this.pitch + dy * 0.007, -1.5, 1.5); }
    dolly(factor) { this.zoom = clamp(this.zoom * factor, 0.55, 3.5); }
    pan(dx, dy) {
      const b = this.basis(), unitsPerPixel = 2 * b.distance / (b.lens * this.height);
      this.target = add(this.target, add(scale(b.right, -dx * unitsPerPixel), scale(b.up, dy * unitsPerPixel)));
      this.target = this.target.map((v, i) => clamp(v, -this.extent[["x", "y", "z"][i]], this.extent[["x", "y", "z"][i]]));
    }
    pick(cells, x, y, tolerance = 5) {
      const ray = this.ray(x, y);
      let nearest = Infinity, selected = null;
      for (const cell of cells) {
        const center = world(cell, this.extent), projected = this.project(center);
        if (!projected.visible) continue;
        const radius = sphereRadius(cell) + tolerance / projected.scale;
        const relative = sub(ray.origin, center), b = dot(relative, ray.direction);
        const discriminant = b * b - dot(relative, relative) + radius * radius;
        if (discriminant < 0) continue;
        const near = -b - Math.sqrt(discriminant), far = -b + Math.sqrt(discriminant);
        const t = near > 0 ? near : far;
        if (t > 0 && t < nearest) { nearest = t; selected = cell; }
      }
      return selected;
    }
  }

  function sphereMesh(organic = false) {
    const vertices = [], indices = [], rings = 10, sides = 14;
    for (let r = 0; r <= rings; r++) for (let s = 0; s <= sides; s++) {
      const theta = r * Math.PI / rings, phi = s * 2 * Math.PI / sides;
      const normal = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
      const radius = organic ? 1 + 0.12 * Math.sin(phi * 3 + theta) * Math.sin(theta) ** 2 : 1;
      vertices.push(...scale(normal, radius), ...normal);
    }
    for (let r = 0; r < rings; r++) for (let s = 0; s < sides; s++) {
      const a = r * (sides + 1) + s, b = a + sides + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
    return { vertices, indices };
  }
  function tubeMesh(taper = 1) {
    const vertices = [], indices = [], sides = 6;
    for (let end = 0; end < 2; end++) for (let s = 0; s <= sides; s++) {
      const angle = s * Math.PI * 2 / sides, x = Math.cos(angle), z = Math.sin(angle);
      const radius = end ? taper : 1;
      vertices.push(x * radius, end, z * radius, x, 1 - taper, z);
    }
    for (let s = 0; s < sides; s++) {
      const b = s + sides + 1;
      indices.push(s, b, s + 1, b, b + 1, s + 1);
    }
    return { vertices, indices };
  }
  const vertexSource = `#version 300 es
    precision highp float;
    layout(location=0) in vec3 position;
    layout(location=1) in vec3 normal;
    layout(location=2) in mat4 model;
    layout(location=6) in vec4 color;
    uniform vec3 eye, cameraRight, cameraUp, cameraForward;
    uniform vec2 lens, clipRange;
    out vec3 vNormal;
    out vec4 vColor;
    out float vDepth;
    void main() {
      vec3 delta = (model * vec4(position, 1.0)).xyz - eye;
      float depth = dot(delta, cameraForward);
      float a = (clipRange.y + clipRange.x) / (clipRange.y - clipRange.x);
      float b = -2.0 * clipRange.y * clipRange.x / (clipRange.y - clipRange.x);
      gl_Position = vec4(dot(delta, cameraRight) * lens.x, dot(delta, cameraUp) * lens.y, a * depth + b, depth);
      vNormal = normalize(transpose(inverse(mat3(model))) * normal);
      vColor = color;
      vDepth = depth;
    }`;
  const fragmentSource = `#version 300 es
    precision highp float;
    in vec3 vNormal;
    in vec4 vColor;
    in float vDepth;
    uniform float fogDistance;
    out vec4 outColor;
    void main() {
      vec3 n = normalize(vNormal);
      float light = 0.57 + 0.43 * max(dot(n, normalize(vec3(-0.4, 0.85, 0.7))), 0.0);
      float fog = clamp((vDepth / fogDistance - 0.6) * 0.3, 0.0, 0.45);
      outColor = vec4(mix(vColor.rgb * light, vec3(0.96, 0.97, 0.94), fog), vColor.a);
    }`;

  class VolumeView {
    constructor(canvas, labels, { onSelect, onHover, onChange, onKey, onError }) {
      this.canvas = canvas; this.labels = labels; this.context = labels.getContext("2d");
      this.camera = new OrbitCamera(); this.callbacks = { onSelect, onHover, onChange, onKey, onError };
      this.gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: false });
      this.field = null; this.pointers = new Map(); this.gestureMoved = false; this.lost = false;
      this.cacheKey = null;
      if (this.gl) this.initialize();
      else this.callbacks.onError("3D graphics are unavailable in this browser. Try a browser with WebGL 2 enabled.");
      canvas.addEventListener("webglcontextlost", event => {
        event.preventDefault(); this.lost = true;
        this.callbacks.onError("3D graphics paused. Waiting for the browser to restore the view.");
      });
      canvas.addEventListener("webglcontextrestored", () => {
        this.lost = false; this.cacheKey = null; this.initialize();
        this.callbacks.onError(""); this.callbacks.onChange();
      });
      this.bindControls();
    }
    initialize() {
      const gl = this.gl;
      const shader = (type, source) => {
        const result = gl.createShader(type); gl.shaderSource(result, source); gl.compileShader(result);
        if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result));
        return result;
      };
      this.program = gl.createProgram();
      const vs = shader(gl.VERTEX_SHADER, vertexSource), fs = shader(gl.FRAGMENT_SHADER, fragmentSource);
      gl.attachShader(this.program, vs); gl.attachShader(this.program, fs); gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
      gl.deleteShader(vs); gl.deleteShader(fs);
      this.uniforms = Object.fromEntries(["eye", "cameraRight", "cameraUp", "cameraForward", "lens", "clipRange", "fogDistance"].map(name => [name, gl.getUniformLocation(this.program, name)]));
      this.spheres = this.makeMesh(sphereMesh()); this.tubes = this.makeMesh(tubeMesh());
      this.somas = this.makeMesh(sphereMesh(true)); this.branches = this.makeMesh(tubeMesh(0.65));
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
    }
    makeMesh(mesh) {
      const gl = this.gl, vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.vertices), gl.STATIC_DRAW);
      for (let i = 0; i < 2; i++) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 3, gl.FLOAT, false, 24, i * 12); }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.indices), gl.STATIC_DRAW);
      const instances = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, instances);
      for (let i = 0; i < 5; i++) {
        gl.enableVertexAttribArray(i + 2); gl.vertexAttribPointer(i + 2, 4, gl.FLOAT, false, 80, i * 16); gl.vertexAttribDivisor(i + 2, 1);
      }
      return { vao, instances, count: mesh.indices.length };
    }
    resize(width, height, dpr) {
      this.width = Math.max(1, width); this.height = Math.max(1, height); this.dpr = dpr;
      for (const canvas of [this.canvas, this.labels]) { canvas.width = Math.round(this.width * dpr); canvas.height = Math.round(this.height * dpr); }
      this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.camera.resize(this.width, this.height);
      if (this.gl && !this.lost) this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    bindControls() {
      const canvas = this.canvas, position = event => {
        const rect = canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      };
      canvas.addEventListener("contextmenu", event => event.preventDefault());
      canvas.addEventListener("pointerdown", event => {
        canvas.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId);
        this.pointers.set(event.pointerId, { ...position(event), start: position(event) });
        if (this.pointers.size === 1) this.gestureMoved = false;
        if (this.pointers.size > 1) this.gestureMoved = true;
        canvas.classList.add("dragging");
      });
      canvas.addEventListener("pointermove", event => {
        const next = position(event), previous = this.pointers.get(event.pointerId);
        if (!previous) {
          this.callbacks.onHover(this.field ? this.camera.pick(this.field.neurons, next.x, next.y)?.id ?? null : null);
          return;
        }
        const before = [...this.pointers.values()];
        this.pointers.set(event.pointerId, { ...previous, ...next });
        if (Math.hypot(next.x - previous.start.x, next.y - previous.start.y) > 4) this.gestureMoved = true;
        if (this.pointers.size === 2) {
          const after = [...this.pointers.values()];
          const oldGap = Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y);
          const newGap = Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y);
          if (oldGap > 2 && newGap > 2) this.camera.dolly(newGap / oldGap);
          this.camera.pan((next.x - previous.x) / 2, (next.y - previous.y) / 2);
        } else if (event.shiftKey || event.buttons === 2 || event.buttons === 4) {
          this.camera.pan(next.x - previous.x, next.y - previous.y);
        } else if (this.gestureMoved) this.camera.orbit(next.x - previous.x, next.y - previous.y);
        this.callbacks.onChange();
      });
      const release = (event, cancelled = false) => {
        if (!this.pointers.has(event.pointerId)) return;
        if (!cancelled && !this.gestureMoved && this.field) {
          const p = position(event);
          this.callbacks.onSelect(this.camera.pick(this.field.neurons, p.x, p.y, event.pointerType === "touch" ? 12 : 5)?.id ?? null);
        }
        this.pointers.delete(event.pointerId);
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        if (!this.pointers.size) canvas.classList.remove("dragging");
      };
      canvas.addEventListener("pointerup", event => release(event));
      canvas.addEventListener("pointercancel", event => release(event, true));
      canvas.addEventListener("lostpointercapture", event => { this.pointers.delete(event.pointerId); if (!this.pointers.size) canvas.classList.remove("dragging"); });
      canvas.addEventListener("pointerleave", () => { if (!this.pointers.size) this.callbacks.onHover(null); });
      canvas.addEventListener("wheel", event => {
        event.preventDefault();
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1);
        this.camera.dolly(Math.exp(-clamp(delta, -120, 120) * 0.002));
        this.callbacks.onChange();
      }, { passive: false });
      canvas.addEventListener("keydown", event => {
        const moves = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12] };
        if (moves[event.key]) {
          event.preventDefault();
          const [dx, dy] = moves[event.key];
          if (event.shiftKey) this.camera.pan(dx, dy); else this.camera.orbit(dx, dy);
        } else if (["+", "=", "-"].includes(event.key)) {
          event.preventDefault(); this.camera.dolly(event.key === "-" ? 0.9 : 1.1);
        } else if (event.key === "Home") { event.preventDefault(); this.camera.reset(); }
        else this.callbacks.onKey(event);
        this.callbacks.onChange();
      });
    }
    sphere(batch, center, radius, color) {
      batch.push(radius, 0, 0, 0, 0, radius, 0, 0, 0, 0, radius, 0, ...center, 1, ...color);
    }
    soma(batch, center, radii, color) {
      batch.push(radii[0], 0, 0, 0, 0, radii[1], 0, 0, 0, 0, radii[2], 0, ...center, 1, ...color);
    }
    tube(batch, start, end, radius, color) {
      const direction = sub(end, start);
      if (length(direction) < 1e-5) return;
      const axis = unit(direction), u = scale(unit(cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), radius);
      const v = scale(unit(cross(axis, u)), radius);
      batch.push(...u, 0, ...direction, 0, ...v, 0, ...start, 1, ...color);
    }
    ring(batch, center, radius, axis, color, tubeRadius = 0.6) {
      const points = Array.from({ length: 49 }, (_, i) => {
        const point = [...center], angle = i * Math.PI / 24;
        point[(axis + 1) % 3] += Math.cos(angle) * radius;
        point[(axis + 2) % 3] += Math.sin(angle) * radius;
        return point;
      });
      for (let i = 1; i < points.length; i++) this.tube(batch, points[i - 1], points[i], tubeRadius, color);
    }
    bounds(extent) {
      const tubes = [], x = extent.x / 2, y = extent.y / 2, z = extent.z / 2;
      const corners = [];
      for (const px of [-x, x]) for (const py of [-y, y]) for (const pz of [-z, z]) corners.push([px, py, pz]);
      for (let i = 0; i < corners.length; i++) for (let j = i + 1; j < corners.length; j++) {
        if (corners[i].filter((v, a) => v !== corners[j][a]).length === 1) this.tube(tubes, corners[i], corners[j], 0.85, [0.52, 0.64, 0.52, 0.65]);
      }
      for (let px = -x; px <= x; px += 100) this.tube(tubes, [px, -y, -z], [px, -y, z], 0.4, [0.65, 0.73, 0.61, 0.35]);
      for (let pz = -z; pz <= z; pz += 100) this.tube(tubes, [-x, -y, pz], [x, -y, pz], 0.4, [0.65, 0.73, 0.61, 0.35]);
      return tubes;
    }
    path(source, target, id, extent) {
      const a = world(source, extent), b = world(target, extent), delta = sub(b, a);
      const perpendicular = unit(cross(delta, Math.abs(unit(delta)[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1]));
      const bend = (id.charCodeAt(id.length - 1) % 2 ? 1 : -1) * Math.min(22, length(delta) * 0.12);
      const control = add(scale(add(a, b), 0.5), scale(perpendicular, bend));
      return t => add(add(scale(a, (1 - t) ** 2), scale(control, 2 * t * (1 - t))), scale(b, t * t));
    }
    updateStructure(field, selectedId, hoverId) {
      const extent = field.config.extent;
      const key = [field.seed, field.time, field.neurons.length, field.stats.formed, field.stats.pruned, selectedId, hoverId].join("/");
      if (this.cacheKey === key && this.field === field) return;
      if (this.field !== field) { this.shapes = new Map(); this.branchLayoutKey = null; }
      this.cacheKey = key; this.field = field;
      this.sphereData = []; this.tubeData = []; this.somaCells = [];
      this.boxData = this.bounds(extent); this.accentData = [];
      for (const domain of field.displayDomains ?? []) {
        const corners=[];for(const x of domain.bounds.x)for(const y of domain.bounds.y)for(const z of domain.bounds.z??[0,0])corners.push({x,y,z});
        for(let i=0;i<8;i++)for(let j=i+1;j<8;j++)if(['x','y','z'].filter(a=>corners[i][a]!==corners[j][a]).length===1)this.tube(this.boxData,world(corners[i],extent),world(corners[j],extent),1,[.35,.53,.64,.5]);
      }
      const assembly=field.assembly,readouts=assembly?(assembly.reference??assembly.latest):null;
      const s1=new Set(readouts?.S1?.b??[]),s2=new Set(readouts?.S2?.b??[]);
      if(assembly) {
        const zones=assembly.bounds??[{min:60,max:440},{min:560,max:940}];
        for(const [lo,hi,color]of [[zones[0].min,zones[0].max,[.23,.55,.72,.6]],[zones[1].min,zones[1].max,[.67,.39,.56,.6]]]) {
          const corners=[];for(const x of [lo,hi])for(const y of [0,extent.y])for(const z of [0,extent.z])corners.push({x,y,z});
          for(let i=0;i<8;i++)for(let j=i+1;j<8;j++)if(['x','y','z'].filter(a=>corners[i][a]!==corners[j][a]).length===1)this.tube(this.boxData,world(corners[i],extent),world(corners[j],extent),1.4,color);
        }
        if(!field.features.distributedAttractant)this.sphere(this.sphereData,world({x:750,y:310,z:310},extent),10,[.90,.65,.20,1]);
      }
      const cells = new Map(field.neurons.map(cell => [cell.id, cell]));
      const linked = new Set(field.links.filter(link => link.sourceId === selectedId || link.targetId === selectedId).flatMap(link => [link.sourceId, link.targetId]));
      // Decorative geometry is static between placement changes. Updating colors
      // in a reusable buffer avoids rebuilding thousands of arbors every tick.
      const layoutKey = field.neurons.map(cell => [cell.id, cell.x, cell.y, cell.z].join(",")).join(";");
      if (this.branchLayoutKey !== layoutKey) {
        this.branchLayoutKey = layoutKey; this.branchRanges = new Map(); this.branchColors = new Map();
        const branches = [];
        for (const cell of field.neurons) {
          if (!this.shapes.has(cell.id)) this.shapes.set(cell.id, neuronShape(cell.id));
          const center = world(cell, extent), ranges = [];
          for (const stem of this.shapes.get(cell.id).stems) {
            const start = branches.length;
            for (let i = 1; i < stem.points.length; i++)
              this.tube(branches, add(center, stem.points[i - 1]), add(center, stem.points[i]), stem.radius * 0.65 ** (i - 1), [0, 0, 0, 0]);
            ranges.push({ start, end: branches.length, kind: stem.kind });
          }
          this.branchRanges.set(cell.id, ranges);
        }
        this.branchData = new Float32Array(branches);
      }
      this.paths = new Map();
      for (const link of field.links) {
        const source = cells.get(link.sourceId), target = cells.get(link.targetId);
        if (!source || !target) continue;
        const path = this.path(source, target, link.id, extent);
        this.paths.set(link.id, path);
        const related = link.sourceId === selectedId || link.targetId === selectedId;
        const weight = clamp(link.weight / field.config.maxWeight, 0, 1);
        const color = source.inhibitory && field.features.inhibitoryPopulation ? [0.59, 0.36, 0.66, related ? 1 : .7] : related ? [0.24, 0.51, 0.33, 1] : selectedId ? [0.68, 0.76, 0.65, 0.45] : [0.48, 0.65, 0.46, 0.8];
        let previous = path(0);
        const segments=link.tract?24:8;
        for (let i = 1; i <= segments; i++) {
          const next = path(i / segments);
          if(!link.tract||i%2)this.tube(this.tubeData, previous, next, 0.55 + weight * 1.35 + Number(related) * 0.5, color);
          previous = next;
        }
      }
      for (const cell of field.neurons) {
        const center = world(cell, extent), active = cell.activity > 0.55;
        const focused = cell.id === selectedId || cell.id === hoverId;
        const faded = selectedId && !focused && !linked.has(cell.id);
        const radius = sphereRadius(cell);
        if (!this.shapes.has(cell.id)) this.shapes.set(cell.id, neuronShape(cell.id));
        const shape = this.shapes.get(cell.id);
        const memberColor=s1.has(cell.id)&&s2.has(cell.id)?[.59,.36,.74,.85]:s1.has(cell.id)?[.19,.58,.82,.85]:s2.has(cell.id)?[.85,.37,.54,.85]:null;
        const color = memberColor??(active ? [0.94, 0.79, 0.40, 0.64] : faded ? [0.78, 0.84, 0.73, 0.48] : [0.70, 0.83, 0.60, 0.62]);
        this.somaCells.push({ center, radii: scale(shape.radii, radius), color });
        this.sphere(this.sphereData, center, radius * 0.48,
          memberColor?[...memberColor.slice(0,3),1]:active ? [0.70, 0.49, 0.13, 1] : faded ? [0.59, 0.69, 0.55, 1] : cell.inhibitory ? [0.49, 0.30, 0.57, 1] : [0.28, 0.48, 0.35, 1]);
        if(assembly) {
          const cue=assembly.stimuli.S1.includes(cell.id)?[.19,.58,.82,1]:assembly.stimuli.S2.includes(cell.id)?[.85,.37,.54,1]:null;
          if(cue)for(const axis of [0,2])this.ring(this.accentData,center,radius+6,axis,cue,1.3);
          if(assembly.current?.[assembly.zoneOf(cell.id)?.toLowerCase()]?.includes(cell.id))this.ring(this.accentData,center,radius+10,1,[.95,.68,.17,.9],1.2);
        }
        if(memberColor)this.ring(this.accentData,center,radius+5,2,[...memberColor.slice(0,3),1],1.4);
        const branchColorKey = [active, Boolean(faded), Boolean(cell.inhibitory), memberColor?.join(',')??'',Boolean(assembly)].join("/");
        if (this.branchColors.get(cell.id) !== branchColorKey) for (const stem of this.branchRanges.get(cell.id)) {
          const branchColor = assembly ? (memberColor?[...memberColor.slice(0,3),.9]:[.57,.66,.60,.30]) : active ? [0.73, 0.61, 0.29, faded ? 0.4 : 0.9] : cell.inhibitory ? [0.58, 0.40, 0.64, faded ? 0.4 : 0.85] :
            stem.kind === "axon" ? [0.44, 0.57, 0.34, faded ? 0.35 : 0.85] : [0.48, 0.66, 0.43, faded ? 0.35 : 0.85];
          for (let offset = stem.start + 16; offset < stem.end; offset += 20) this.branchData.set(branchColor, offset);
        }
        this.branchColors.set(cell.id, branchColorKey);
        if (cell.inhibitory) {
          this.ring(this.accentData, center, sphereRadius(cell) + 7, 1, [0.60, 0.35, 0.67, 1]);
          this.tube(this.accentData, add(center, [-9, 0, 0]), add(center, [9, 0, 0]), 1.8, [0.60, 0.35, 0.67, 1]);
        }
        if (focused || cell.drivePeriod !== null || cell.recordOutput) {
          for (let axis = 0; axis < 3; axis++) this.ring(this.accentData, center, sphereRadius(cell) + 5, axis, [0.38, 0.57, 0.43, 0.7]);
        }
        if (cell.id === selectedId) {
          for (let axis = 0; axis < 3; axis++) this.ring(this.accentData, center, cell.radius, axis, [0.50, 0.68, 0.52, 0.35]);
        }
      }
    }
    drawBatch(mesh, data) {
      if (!data.length) return;
      const gl = this.gl;
      gl.bindVertexArray(mesh.vao); gl.bindBuffer(gl.ARRAY_BUFFER, mesh.instances);
      gl.bufferData(gl.ARRAY_BUFFER, data instanceof Float32Array ? data : new Float32Array(data), gl.DYNAMIC_DRAW);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0, data.length / 20);
    }
    render(field, selectedId, hoverId) {
      if (!this.gl || this.lost) return;
      this.camera.resize(this.width, this.height, field.config.extent);
      this.updateStructure(field, selectedId, hoverId);
      const gl = this.gl, b = this.camera.basis(), u = this.uniforms;
      gl.useProgram(this.program); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      for (const [name, value] of [["eye", b.eye], ["cameraRight", b.right], ["cameraUp", b.up], ["cameraForward", b.forward]]) gl.uniform3fv(u[name], value);
      gl.uniform2f(u.lens, b.lens / b.aspect, b.lens); gl.uniform2f(u.clipRange, b.near, b.far);
      gl.uniform1f(u.fogDistance, b.distance);
      gl.depthMask(true);
      this.drawBatch(this.tubes, this.tubeData); this.drawBatch(this.branches, this.branchData);
      this.drawBatch(this.spheres, this.sphereData);
      const pulses = [];
      for (const cell of field.neurons) for (const message of cell.inbox) {
        const path = this.paths.get(message.synapseId);
        if (!path) continue;
        const t = clamp((field.time - message.sentAt) / Math.max(0.001, message.at - message.sentAt), 0, 1);
        this.sphere(pulses, path(t), 4.5, message.synapticInhibition ? [0.67, 0.36, 0.73, 1] : [0.98, 0.73, 0.23, 1]);
      }
      this.drawBatch(this.spheres, pulses);
      gl.depthMask(false);
      // Translucent membranes reveal the nucleus from every orbit angle.
      const membranes = [];
      const ordered = [...this.somaCells].sort((a, c) => dot(sub(c.center, a.center), b.forward));
      for (const cell of ordered) this.soma(membranes, cell.center, cell.radii, cell.color);
      this.drawBatch(this.somas, membranes);
      this.drawBatch(this.tubes, this.boxData); this.drawBatch(this.tubes, this.accentData);
      gl.depthMask(true);
      this.drawLabels(field, selectedId, hoverId);
    }
    drawLabels(field, selectedId, hoverId) {
      const ctx = this.context, extent = field.config.extent;
      ctx.clearRect(0, 0, this.width, this.height);
      const label = (position, text, color, offset = 0) => {
        const p = this.camera.project(position);
        if (!p.visible || p.x < 0 || p.x > this.width || p.y < 0 || p.y > this.height) return;
        ctx.font = "10px Consolas, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const width = ctx.measureText(text).width + 10;
        ctx.fillStyle = "rgba(249,251,246,0.9)"; ctx.fillRect(p.x - width / 2, p.y + offset - 8, width, 16);
        ctx.fillStyle = color; ctx.fillText(text, p.x, p.y + offset);
      };
      label([0, -extent.y / 2 - 18, extent.z / 2], "X · " + extent.x, "#698463", 12);
      label([-extent.x / 2 - 14, 0, extent.z / 2], "Y · " + extent.y, "#698463", -8);
      label([extent.x / 2 + 14, -extent.y / 2, 0], "Z · " + extent.z, "#698463", 12);
      for (const domain of field.displayDomains ?? []) label(world({x:(domain.bounds.x[0]+domain.bounds.x[1])/2,y:domain.bounds.y[0]+15,z:((domain.bounds.z?.[0]??0)+(domain.bounds.z?.[1]??0))/2},extent),domain.name.toUpperCase(),"#4e7484",-18);
      if(field.assembly) {
        label(world({x:250,y:15,z:310},extent),"ZONE A · CUES", "#307da4",-18);
        label(world({x:750,y:15,z:310},extent),"ZONE B · READOUT", "#a04e75",-18);
        if(!field.features.distributedAttractant)label(world({x:750,y:310,z:310},extent),"ATTRACTANT SOURCE", "#a87716",-22);
        else label(world({x:750,y:590,z:310},extent),"B CELLS SECRETE", "#a87716",18);
      }
      for (const cell of field.neurons) {
        const role = field.endpointLabel?.(cell.id) || (cell.drivePeriod !== null ? "INPUT" : cell.recordOutput ? "OUTPUT" : null);
        if (role || cell.id === selectedId || cell.id === hoverId) label(world(cell, extent), role || (cell.inhibitory ? "− INHIBITORY " : "CELL ") + cell.id, cell.inhibitory ? "#865094" : "#365f45", -22);
      }
      // A world-axis compass rotates with the camera, independent of zoom.
      const b = this.camera.basis(), origin = { x: this.width - 47, y: 58 };
      for (const [i, text, color] of [[0, "X", "#617d64"], [1, "Y", "#b48c45"], [2, "Z", "#6c91a1"]]) {
        const axis = [0, 0, 0]; axis[i] = i === 1 ? -1 : 1;
        const dx = dot(axis, b.right) * 22, dy = -dot(axis, b.up) * 22;
        ctx.beginPath(); ctx.moveTo(origin.x, origin.y); ctx.lineTo(origin.x + dx, origin.y + dy);
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.font = "9px Consolas, monospace"; ctx.textAlign = "center"; ctx.fillStyle = color;
        ctx.fillText(text, origin.x + dx * 1.4, origin.y + dy * 1.4);
      }
    }
  }
  const api = { OrbitCamera, VolumeView, world, neuronShape };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.NeuronVolume = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
